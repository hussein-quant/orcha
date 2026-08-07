"""Local-repo code source (Orcha Cloud local run — Addendum 2): a thin, safe wrapper
over `git -C $ORCHA_LOCAL_REPO_DIR` that lets the browse/Code Space surfaces read the
project's OWN working tree with zero GitHub setup — the sentinel repo binding "local"
(see `docs/orcha-cloud-local-run.md` "Addendum 2").

The compose template mounts the project root read-only at ORCHA_LOCAL_REPO_DIR
(`../ -> /app/workspace:ro`) and the portal image carries the `git` binary. Every
function here operates on COMMITTED state only (HEAD/branches/tags) — v1 deliberately
does not diff the working tree; that stays the run-feed's job (see the design doc).

Contract mirrored from github_repo_browse_routes.py so callers can branch on
`repo == "local"` at a handful of chokepoints and otherwise reuse the exact same
downstream shapes (tree entries, snapshot dict, symbol indexer, etc.):
  - tree(ref)          -> [{"path","type":"blob"|"tree","sha","size"}, ...] (GitHub's
                           own git/trees?recursive=1 shape, so `_fetch_full_tree`-style
                           callers need no reshaping)
  - file_bytes(ref,path)-> raw bytes | None (binary-safe; caller does its own
                           NUL-byte binary sniff, exactly like the GitHub path)
  - resolve_ref(ref)    -> full 40-char commit sha | None
  - branches()          -> [{"name","is_head":bool}, ...]
  - grep(ref,q)         -> [{"path","line","text"}, ...] (bounded)
  - archive_bytes(ref)  -> raw `git archive --format=tar` bytes | None (feeds the SAME
                           in-memory tar extraction `_extract_source_files` already
                           does for a GitHub tarball — plain tar here, no gzip, so
                           callers open it with mode="r")
  - log1(ref)           -> {"sha","committed_at"} | None

SAFETY: every subprocess call is `subprocess.run([...], timeout=..., shell=False)` —
argv lists only, never a shell string, so there is no shell-injection surface even
though `q`/`ref`/`path` are caller-controlled. Path arguments (`path` in file_bytes,
and any repo-relative path this module ever trusts) are validated by `_safe_rel_path`
BEFORE being handed to git — reject absolute paths and any path containing a `..`
segment, mirroring the rigor `github_repo_browse_routes._safe_tar_members` applies to
tar member names. `ref`/`q` are passed as separate argv elements (never interpolated
into a shell string), so a hostile ref like `--upload-pack=...` still can't be
mistaken for a git option BECAUSE every call that accepts a caller ref places it after
a literal `--` separator wherever git syntax allows one, and otherwise validates it
looks like a plausible ref/sha first.

Every function degrades to None/[]/False on ANY failure (git not installed, dir
missing, bad ref, git binary error, timeout) — logged, never raised as a 500. This
module never talks to a database or FastAPI; it is a pure subprocess wrapper so it's
trivially testable against a real temp git repo (see tests/test_local_git_source.py).
"""

import logging
import os
import re
import subprocess

logger = logging.getLogger("portal_backend.local_git")

# Every subprocess call is bounded — a huge repo / hung git process must never hang a
# request indefinitely. Generous enough for `git archive` on a large-ish repo, short
# enough that a genuinely hung git process fails a request quickly rather than exhausting
# the portal's worker threads.
GIT_TIMEOUT_SECONDS = 20

# grep/search result caps — mirrors github_repo_browse_routes.NAMES_SEARCH_MAX_RESULTS /
# CONTENTS_SEARCH_MAX_RESULTS in spirit: bounded so a broad query never blows up the
# response or makes `git grep` walk forever on a huge repo.
GREP_MAX_RESULTS = 200

_FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
# A conservative allow-list for a caller-supplied ref/branch/tag/short-sha BEFORE it is
# ever passed to git: word characters, dots, dashes, slashes (branch namespaces like
# "feat/x"), carets/tildes (relative refs like "HEAD~1"). Deliberately does not include
# leading '-' (a git *option* look-alike) — checked separately below.
_SAFE_REF_RE = re.compile(r"^[\w][\w./~^-]*$")


def _env_dir() -> str:
    return (os.environ.get("ORCHA_LOCAL_REPO_DIR") or "").strip()


def available() -> bool:
    """Whether the local-repo source can be used at all: the env var is set, the
    directory exists, it contains a `.git` (a real repo, not just any mounted dir),
    and the `git` binary itself is reachable. Cheap enough to call on every request
    that might need it (no caching — a missing/misconfigured mount should be visible
    immediately, not sticky-cached as unavailable)."""
    path = _env_dir()
    if not path:
        return False
    if not os.path.isdir(path):
        return False
    if not os.path.exists(os.path.join(path, ".git")):
        return False
    return _git_binary_present()


def _git_binary_present() -> bool:
    try:
        result = subprocess.run(
            ["git", "--version"],
            capture_output=True,
            timeout=GIT_TIMEOUT_SECONDS,
            shell=False,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _safe_ref(ref) -> bool:
    """A caller-supplied ref/branch/tag/short-or-full-sha is safe to pass to git: a
    non-empty string matching the conservative allow-list above, and NOT starting with
    '-' (which git would otherwise parse as an option rather than a revision — the same
    class of bug `git <subcommand> -- <path>` separators guard against elsewhere in this
    module)."""
    if not isinstance(ref, str) or not ref:
        return False
    if ref.startswith("-"):
        return False
    return bool(_SAFE_REF_RE.match(ref))


def _safe_rel_path(path) -> bool:
    """A repo-relative path is safe to pass to git: non-empty, not absolute, and no
    `..` path segment anywhere — mirrors the traversal check
    `github_repo_browse_routes._safe_tar_members` applies to tar member names (see its
    docstring for the full rationale). Rejects a leading '-' too, for the same
    option-look-alike reason `_safe_ref` does."""
    if not isinstance(path, str) or not path:
        return False
    if path.startswith("-"):
        return False
    normalized = path.replace("\\", "/")
    if normalized.startswith("/"):
        return False
    parts = normalized.split("/")
    if any(p == ".." for p in parts):
        return False
    return True


def _run(args: list, *, binary: bool = False):
    """Run `git -C <ORCHA_LOCAL_REPO_DIR> <args>`, returning stdout (bytes if
    binary=True, else text) on success or None on ANY failure (non-zero exit, git
    missing, timeout, dir missing). Never raises to the caller; every failure is
    logged at debug level (expected/routine — a bad ref or missing path is a normal
    occurrence, not a portal error) so the None just means 'not found / unavailable'.
    The ONE subprocess leaf in this module — every public function below funnels
    through this."""
    repo_dir = _env_dir()
    if not repo_dir:
        return None
    full_args = ["git", "-C", repo_dir] + args
    try:
        result = subprocess.run(
            full_args,
            capture_output=True,
            timeout=GIT_TIMEOUT_SECONDS,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("local_git: %s failed to run: %s", full_args, exc)
        return None
    if result.returncode != 0:
        logger.debug(
            "local_git: %s exited %s: %s",
            full_args, result.returncode,
            (result.stderr or b"").decode("utf-8", errors="ignore")[:500],
        )
        return None
    return result.stdout if binary else result.stdout.decode("utf-8", errors="ignore")


def resolve_ref(ref=None) -> "str | None":
    """Turn a ref (branch/tag/short-or-full-sha, or None/'' -> HEAD) into the full
    40-char commit sha it currently points at. None on a bad ref, an empty repo (no
    commits yet), or any git failure."""
    if not available():
        return None
    target = ref if ref else "HEAD"
    if target != "HEAD" and not _safe_ref(target):
        return None
    out = _run(["rev-parse", "--verify", "--quiet", f"{target}^{{commit}}"])
    if out is None:
        return None
    sha = out.strip()
    return sha if _FULL_SHA_RE.match(sha) else None


def branches() -> list:
    """Every local branch as {"name", "is_head": bool}, HEAD-marked via a separate
    symbolic-ref read (rather than parsing for-each-ref's own HEAD decoration, which
    varies by git version) so the marker is unambiguous. Empty list on any failure or
    an empty repo (no commits/branches yet — a normal state right after `git init`,
    not an error)."""
    if not available():
        return []
    out = _run(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    if out is None:
        return []
    names = [line.strip() for line in out.splitlines() if line.strip()]
    head_out = _run(["symbolic-ref", "--quiet", "--short", "HEAD"])
    head_name = head_out.strip() if head_out else None
    return [{"name": n, "is_head": n == head_name} for n in names]


def tree(ref=None) -> "list | None":
    """The FULL recursive tree at `ref` (default HEAD), in the same shape GitHub's
    `git/trees?recursive=1` returns: [{"path","type":"blob"|"tree","sha","size"}].
    `size` is included only for blobs (mirrors GitHub, which omits it for trees).
    None when the ref can't be resolved or git fails (never [] for that case — an
    empty list is reserved for a genuinely empty tree, e.g. an empty commit)."""
    sha = resolve_ref(ref)
    if sha is None:
        return None
    # ls-tree -r -t: recursive, include tree (directory) entries too — GitHub's
    # recursive tree response includes both blobs and trees, and code_space_routes'
    # blob-sha comparison indexes by (path -> sha) across both kinds.
    out = _run(["ls-tree", "-r", "-t", "-l", sha])
    if out is None:
        return None
    entries = []
    for line in out.splitlines():
        # Format: "<mode> <type> <sha> <size|'-'>\t<path>"
        if "\t" not in line:
            continue
        meta, path = line.split("\t", 1)
        fields = meta.split()
        if len(fields) < 4:
            continue
        _mode, obj_type, obj_sha, size_field = fields[0], fields[1], fields[2], fields[3]
        entry_type = "blob" if obj_type == "blob" else "tree"
        entry = {"path": path, "type": entry_type, "sha": obj_sha}
        if entry_type == "blob" and size_field.isdigit():
            entry["size"] = int(size_field)
        entries.append(entry)
    return entries


def blob_sha(ref, path) -> "str | None":
    """The blob sha for one path at `ref` — a small convenience over `tree()` for
    callers (like code_space's blob_match check) that only need one path's sha rather
    than the whole tree. None when the path/ref doesn't resolve to a blob."""
    entries = tree(ref)
    if entries is None:
        return None
    for entry in entries:
        if entry["path"] == path and entry["type"] == "blob":
            return entry["sha"]
    return None


def file_bytes(ref, path) -> "bytes | None":
    """One file's raw content at `ref` via `git show <sha>:<path>` — binary-safe (no
    text decode here; callers do their own NUL-byte binary sniff exactly like the
    GitHub contents-API path does). None when: the path fails `_safe_rel_path`, the
    ref doesn't resolve, the path doesn't exist at that ref, or git fails."""
    if not _safe_rel_path(path):
        return None
    sha = resolve_ref(ref)
    if sha is None:
        return None
    out = _run(["show", f"{sha}:{path}"], binary=True)
    return out


def grep(ref, q) -> "list | None":
    """Content search: `git grep -n --max-count` for `q` at `ref`, returned as
    [{"path","line","text"}], capped at GREP_MAX_RESULTS. None when the ref doesn't
    resolve, the query is empty, or git fails; [] is a genuine no-match result.
    `-F` (fixed-string, not regex) so an arbitrary user query can't be misread as a
    regex metacharacter soup or, worse, a git-grep option — combined with the `--`
    separator below, `q` can never be interpreted as anything but literal search text."""
    if not q:
        return None
    sha = resolve_ref(ref)
    if sha is None:
        return None
    out = _run(["grep", "-n", "-I", "-F", "-e", q, sha, "--"])
    # git grep exits 1 (not an error here) when there are simply no matches; `_run`
    # already treats any non-zero exit as None, so a genuine "no matches" result and a
    # real git failure are indistinguishable from `_run` alone. Re-run cheaply is
    # wasteful; instead treat None from `_run` here as "no matches or failure" and
    # return [] — honest enough: grep's failure modes on a resolved sha are rare
    # (corrupt object), and a caller already got None upstream if the ref itself was
    # bad. This keeps the common "no matches" case from masquerading as an error state.
    if out is None:
        return []
    results = []
    for line in out.splitlines():
        # Format: "<sha>:<path>:<line_no>:<text>" (git grep's default separator is ':').
        parts = line.split(":", 3)
        if len(parts) < 4:
            continue
        _commit, path, line_no, text = parts
        if not line_no.isdigit():
            continue
        results.append({"path": path, "line": int(line_no), "text": text})
        if len(results) >= GREP_MAX_RESULTS:
            break
    return results


def archive_bytes(ref=None) -> "bytes | None":
    """`git archive --format=tar` at `ref` (default HEAD) — the local equivalent of
    the GitHub tarball snapshot fetch (`_download_tarball_bytes`), feeding the SAME
    in-memory `_extract_source_files` extraction path. Plain `tar` (no gzip — a local
    filesystem read has no download-size pressure the way a GitHub codeload fetch
    does, so skipping compression keeps this call cheap); callers opening it with
    `tarfile.open(fileobj=..., mode="r")` handle both compressed and uncompressed
    equally well, so this is a drop-in byte source. Unlike GitHub's tarball, a local
    `git archive` has NO synthetic top-level `{owner}-{repo}-{sha}/` directory — paths
    are already repo-relative, so a caller reusing `_safe_tar_members`'s stripping
    logic must special-case that (see the route dispatch helper, not this module).
    None when the ref doesn't resolve or archive fails."""
    sha = resolve_ref(ref)
    if sha is None:
        return None
    return _run(["archive", "--format=tar", sha], binary=True)


def log1(ref=None) -> "dict | None":
    """The single most recent commit at `ref` (default HEAD): {"sha","committed_at"}
    (committed_at as an ISO-8601 string, strict — %cI). None when the ref doesn't
    resolve or the repo has no commits yet."""
    sha = resolve_ref(ref)
    if sha is None:
        return None
    out = _run(["log", "-1", "--format=%H%x1f%cI", sha])
    if out is None:
        return None
    line = out.strip()
    if "\x1f" not in line:
        return None
    commit_sha, committed_at = line.split("\x1f", 1)
    return {"sha": commit_sha, "committed_at": committed_at}


def workspace_name() -> "str | None":
    """The local entry's display `name` in the repos list. Inside the container the
    mount lands at a fixed path (/app/workspace), whose basename says nothing about
    the project — so the stack passes the real project name via ORCHA_LOCAL_REPO_NAME
    (compose template) and the mount basename is only the fallback."""
    explicit = (os.environ.get("ORCHA_LOCAL_REPO_NAME") or "").strip()
    if explicit:
        return explicit
    path = _env_dir()
    if not path:
        return None
    return os.path.basename(os.path.normpath(path)) or None
