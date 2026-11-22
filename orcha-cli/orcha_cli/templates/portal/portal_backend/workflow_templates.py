"""Workflow templates (Mobile App Release §3, §4.5, §5).

A template is a versioned JSON document: parameters, roles, stages of steps, and repeat groups.
`compile_template` turns one, with the owner's parameters and the steps they removed, into an
ordinary WorkflowDraft (semantics version 2) plus each step's StepSpec. So a templated workflow
runs on the one engine: the same create, preview, routes, loops and history as any other.

The engine's shape rules hold by construction: at most three prerequisites a step, loops of two
to ten steps that never overlap, and send-back only from a loop's review step. Removing a step
reconnects its dependents to its own prerequisites; removing a loop's review step dissolves the
loop; a gate without a loop loses Send back.
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any

from portal_backend.workflow_graph import conflict

TEMPLATE_SCHEMA = 1
PLATFORMS = ("ios", "android", "web", "api")
PLATFORM_WORD = {"ios": "iOS", "android": "Android", "web": "Web", "api": "API"}


def _o(name, kind):
    return {"name": name, "kind": kind}


def _r(outcome, destination, task=None):
    out = {"outcome": outcome, "destination": destination}
    if task:
        out["destination_task"] = task
    return out


def _step(key, title, kind, *, role=None, after=(), platforms=(), required=False, description="",
          done="", outcomes=(), routes=(), qa=None, watch=None, gate=None, resources=(),
          irreversible=False, outward=None, scope=None, dry_run=None, secrets=(), when=None, keep_after=()):
    step = {
        "client_key": key, "title": title, "kind": kind, "role": role, "after": list(after),
        "platforms": list(platforms), "required": required, "description": description,
        "definition_of_done": done, "outcomes": list(outcomes), "routes": list(routes),
        "resources": list(resources), "irreversible": irreversible, "outward": outward,
        "scope": scope, "secrets": list(secrets),
    }
    if keep_after:
        # Joins a branch back: keep these prerequisites even where another one already waits for them,
        # so the step stays a direct dependent its prerequisite's branch can name.
        step["keep_after"] = list(keep_after)
    for k, v in (("qa", qa), ("watch", watch), ("gate", gate), ("dry_run", dry_run), ("when", when)):
        if v is not None:
            step[k] = v
    return step


def _qa(key, platform, scope, after, required):
    word = PLATFORM_WORD[platform]
    subset = scope == "subset"
    return _step(
        key,
        f"{'Check the changed screens' if subset else 'Full regression'} on {word}",
        "qa", role="qa", after=after, platforms=[platform], required=required, scope=scope,
        description=(
            f"Only the scenarios for the screens this batch changed, plus every open finding, on {word}. "
            "Uses the scenario tags {qa_subset_tags} when set. Runs on a debug build pointed at {qa_target_env}."
            if subset else
            f"Every validated {word} scenario, shared ones included, on the exact commit being released "
            "(a debug build of it pointed at {qa_target_env}; release builds block screenshots). Paused "
            "and suspicious scenarios are listed as skipped, never silently dropped."
        ),
        done=(
            "Every scenario in scope has a verdict with screenshots; the build under test (type, "
            "version, build, commit, environment) is recorded on the result."
        ),
        outcomes=[_o("pass", "success"), _o("fail", "failure")],
        routes=[_r("pass", "next"), _r("fail", "next")],
        qa={"kind": "check", "platform": platform if platform != "api" else None,
            "focus": ("The screens changed in this batch: {batch_summary}" if subset
                      else "Full regression: every validated scenario for this platform.")},
        resources=["device:ios-sim"] if platform == "ios" else ["device:android-emu"] if platform == "android" else [],
        dry_run={"outcomes": ["fail", "pass"] if subset else ["pass"],
                 "note": "Round 1 finds the fee shown as an amount; the fix passes in round 2." if subset else ""},
    )


def mobile_app_release() -> dict:
    """The full Mobile App Release: intake to live, with proof before every irreversible step."""
    stages = [
        {"key": "intake", "title": "Intake", "steps": [
            _step("batch", "Collect the feedback batch", "person", role="owner",
                  description="List the issues and feature requests that make up this release. One build per round, never one per fix.",
                  done="The batch is written down and agreed: {batch_summary}",
                  outcomes=[_o("ready", "success"), _o("not_yet", "failure")],
                  routes=[_r("ready", "next"), _r("not_yet", "stop")]),
            _step("baseline", "Release readiness baseline", "agent", role="release", after=["batch"],
                  description="Run the project's readiness scripts (store status, signing, metadata) and post what is missing.",
                  done="A readiness note lists every gap, or says there is none.",
                  dry_run={"outcomes": []}),
        ]},
        {"key": "build", "title": "Build the change", "steps": [
            _step("implement", "Fix or build each batch item", "agent", role="engineer", after=["baseline"], required=True,
                  description="Test-first, one small PR per batch item, against origin/main in a worktree. In a later round, fix what the QA triage found.",
                  done="Every batch item has an open PR with tests; the PR links are posted.",
                  resources=["build:heavy"]),
            _step("review_merge", "Review and merge", "person", role="owner", after=["implement"],
                  description="Review the diffs and merge. Agents never merge on their own. To ask for changes, comment on the PR; the engineer updates it, and you mark this step once it's merged.",
                  done="Every PR of this round is merged.",
                  outcomes=[_o("merged", "success")], routes=[_r("merged", "next")]),
        ]},
        {"key": "staging", "title": "Staging", "steps": [
            _step("deploy_api_staging", "Deploy the API to staging", "agent", role="release", after=["review_merge"],
                  platforms=["api"],
                  description="Deploy to {qa_target_env}, then prove the change is live there: fetch an endpoint the change touched. A script's exit code is not proof.",
                  done="The changed endpoint answers on {qa_target_env} with the new behaviour (request and response posted)."),
            _step("deploy_web_staging", "Deploy the website to staging", "agent", role="release",
                  after=["deploy_api_staging"], platforms=["web"],
                  description="Deploy to {qa_target_env}, then prove it is live: load a changed page and check the new content. The deploy script can report success without uploading.",
                  done="A changed page on {qa_target_env} shows the new content (URL and screenshot posted)."),
        ]},
        {"key": "verify", "title": "Verify while fixing", "steps": [
            _qa("qa_subset_ios", "ios", "subset", ["deploy_api_staging"], False),
            _qa("qa_subset_android", "android", "subset", ["deploy_api_staging"], False),
            _qa("qa_subset_web", "web", "subset", ["deploy_web_staging"], False),
            _step("triage_subset", "Triage what failed", "qa", role="qa",
                  after=["qa_subset_ios", "qa_subset_android", "qa_subset_web"],
                  description="Sort every failure: a real bug to fix, a flaky check, or a scenario to update. Fixes go back to Build.",
                  done="Every failure has a diagnosis; real bugs are findings with steps to reproduce.",
                  outcomes=[_o("fix", "changes"), _o("clear", "success"), _o("needs_person", "custom")],
                  routes=[_r("fix", "return", "implement"), _r("clear", "exit_group"), _r("needs_person", "ask_owner")],
                  qa={"kind": "triage"}, dry_run={"outcomes": ["fix", "clear"]}),
        ]},
        {"key": "coverage", "title": "Coverage", "steps": [
            _step("coverage", "Draft the missing scenarios", "qa", role="qa", after=["triage_subset"],
                  description="Each user-facing change in the batch needs a validated scenario. Draft the missing ones for the owner to approve. Warns below {coverage_threshold} scenarios a platform.",
                  done="Every change in the batch maps to a scenario, drafted or validated.",
                  outcomes=[_o("drafted", "success"), _o("gaps", "failure")],
                  routes=[_r("drafted", "next"), _r("gaps", "next")],
                  qa={"kind": "draft", "focus": "Scenarios for the changes in this batch: {batch_summary}"}),
            _step("coverage_review", "Approve the new scenarios", "person", role="owner", after=["coverage"],
                  description="Approve or reject the drafted scenarios in Quality. Coverage per platform is on the gate card before you decide.",
                  done="The drafts are approved or rejected.",
                  outcomes=[_o("covered", "success"), _o("go_anyway", "custom")],
                  routes=[_r("covered", "next"), _r("go_anyway", "next")]),
        ]},
        {"key": "builds", "title": "Version and QA builds", "steps": [
            _step("bump", "Version {release_label}", "agent", role="engineer", after=["coverage_review"],
                  platforms=["ios", "android"], required=True,
                  description="Set the versions for this release: {versions_detail}. Build numbers and versionCodes only go up. Open a PR. In a later round, fix what the regression found first, merge, and redeploy staging.",
                  done="{versions_detail} is merged on main; the commit SHA is posted."),
            _step("qa_build", "Build the QA builds", "agent", role="release", after=["bump"],
                  platforms=["ios", "android"],
                  description="Debug builds of that commit pointed at {qa_target_env} (release builds block screenshots; iOS needs signing on so the login token can be saved). Record each build's identity for the QA steps.",
                  done="A debug build per platform is installed on the QA devices; type, version, build, commit and environment are posted.",
                  resources=["build:heavy"]),
        ]},
        {"key": "regression", "title": "Full regression", "steps": [
            _qa("qa_full_ios", "ios", "full", ["qa_build"], "if_ship"),
            _qa("qa_full_android", "android", "full", ["qa_build"], "if_ship"),
            _qa("qa_full_web", "web", "full", ["bump"], "if_ship"),
            _step("triage_full", "Triage the regression", "qa", role="qa",
                  after=["qa_full_ios", "qa_full_android", "qa_full_web"], required="if_ship",
                  description="Sort every regression failure. Real bugs go back to the version step for a fix and a new build.",
                  done="Every failure has a diagnosis.",
                  outcomes=[_o("fix", "changes"), _o("clear", "success"), _o("needs_person", "custom")],
                  routes=[_r("fix", "return", "bump"), _r("clear", "exit_group"), _r("needs_person", "ask_owner")],
                  qa={"kind": "triage"}, dry_run={"outcomes": ["clear"]}),
        ]},
        {"key": "release_builds", "title": "Release builds", "steps": [
            _step("build_ios", "Archive, scan and upload iOS", "agent", role="release", after=["triage_full"],
                  platforms=["ios"],
                  description="Archive and export {version} ({build}) from the commit that passed regression, run the project's pre-upload scans, and upload to App Store Connect.",
                  done="The upload is accepted; the scans' output is posted.",
                  resources=["build:heavy"], secrets=["ASC_KEY"]),
            _step("processing_ios", "Wait for build processing", "watch", after=["build_ios"], platforms=["ios"],
                  description="Watches App Store Connect until build {build} is VALID (usually 5 to 15 minutes).",
                  done="Build {build} is VALID.",
                  outcomes=[_o("valid", "success"), _o("invalid", "failure")],
                  routes=[_r("valid", "next"), _r("invalid", "ask_owner")],
                  watch={"adapter": {"command": "{asc_status_command} --what build --version {version} --build {build}"},
                         "interval_s": 120, "backoff": 1.2, "max_interval_s": 600, "timeout_h": 3,
                         "state_map": {"valid": "valid", "invalid": "invalid", "failed": "invalid"},
                         "terminal_states": ["valid", "invalid", "failed"],
                         "dry_run_states": ["processing", "valid"]}),
            _step("build_android", "Build and upload to internal", "agent", role="release", after=["triage_full"],
                  platforms=["android"],
                  description="Build the signed AAB for {android_version} (versionCode {android_version_code}) and upload to the internal track: a dry run first, then for real.",
                  done="versionCode {android_version_code} is on the internal track.",
                  resources=["build:heavy"], secrets=["PLAY_SERVICE_ACCOUNT"]),
            _step("testflight_owner", "Test the build yourself", "person", role="owner",
                  after=["processing_ios", "build_android"], platforms=["ios", "android"],
                  description="Install from TestFlight and the internal track, and try it on real devices (iPhone, iPad, App Clip, Android phone).",
                  done="You tried the release build on your devices.",
                  outcomes=[_o("ok", "success"), _o("issues", "custom")],
                  routes=[_r("ok", "next"), _r("issues", "next")]),
        ]},
        {"key": "go", "title": "Go / no-go", "steps": [
            _step("gate", "Your go-ahead", "gate", role="owner", after=["testflight_owner"], required="if_ship",
                  description="The proof pack: per-platform counts, every failure with its reason, screenshots of the changed screens, coverage, what only unit tests checked. Nothing reaches a store before you say Go here. A standing 'submit when green' is not accepted.",
                  done="You chose Go, No-go or Send back, with a reason for the last two.",
                  outcomes=[_o("go", "success"), _o("no_go", "failure"), _o("send_back", "changes")],
                  routes=[_r("go", "exit_group"), _r("no_go", "stop"), _r("send_back", "return", "build_ios")],
                  gate={"proof_steps": ["qa_full_ios", "qa_full_android", "qa_full_web", "qa_subset_ios",
                                        "qa_subset_android", "qa_subset_web"],
                        "include_unit_only": True, "include_metadata_diff": True}),
        ]},
        {"key": "ship", "title": "Ship", "steps": [
            _step("submit_ios", "Submit for App Review", "agent", role="release", after=["gate"], platforms=["ios"],
                  irreversible=True, outward="App Store",
                  description="Attach build {build} to version {version}, set the release type to {release_type} (the one you chose for this version), and submit.",
                  done="Version {version} is Waiting for Review with build {build}.", secrets=["ASC_KEY"]),
            _step("promote_android", "Promote to production", "agent", role="release", after=["gate"],
                  platforms=["android"], irreversible=True, outward="Google Play",
                  description="Promote the same versionCode {android_version_code} ({android_version}) to production at {android_rollout} rollout: a dry run, then for real. Managed publishing is off, so an approved update goes live on its own.",
                  done="versionCode {android_version_code} is in production review at {android_rollout}.",
                  secrets=["PLAY_SERVICE_ACCOUNT"]),
            _step("deploy_api_prod", "Deploy the API to production", "agent", role="release", after=["gate"],
                  platforms=["api"], irreversible=True, outward="Production",
                  description="Production deploy, after staging. Then prove the change is live in production: fetch a changed endpoint.",
                  done="The changed endpoint answers in production with the new behaviour."),
            _step("deploy_web_prod", "Deploy the website to production", "agent", role="release",
                  after=["deploy_api_prod"], platforms=["web"], irreversible=True, outward="Production",
                  description="Production deploy, after staging. Then prove it is live: load a changed page.",
                  done="A changed page in production shows the new content."),
        ]},
        {"key": "review", "title": "Store review", "steps": [
            _step("review_ios", "App Store review", "watch", after=["submit_ios"], platforms=["ios"],
                  description="Watches App Review: waiting, in review, then approved or rejected. Approved is not live yet: a manual release waits for you, an automatic one for the App Store.",
                  done="Version {version} is approved, or you decided what a rejection means.",
                  outcomes=[_o("approved", "success"), _o("live", "success"), _o("rejected", "failure"), _o("resubmit", "changes")],
                  routes=[_r("approved", "step", "release_ios"), _r("live", "step", "release_ios"),
                          _r("rejected", "ask_owner"), _r("resubmit", "step", "fix_rejection")],
                  watch={"adapter": {"command": "{asc_status_command} --what review --version {version}"},
                         "interval_s": 900, "backoff": 1.0, "max_interval_s": 1800, "timeout_h": 24 * 7,
                         "state_map": {"approved": "approved", "pending_developer_release": "approved",
                                       "ready_for_sale": "live", "live": "live", "rejected": "rejected",
                                       "metadata_rejected": "rejected"},
                         "terminal_states": ["approved", "pending_developer_release", "ready_for_sale", "live",
                                             "rejected", "metadata_rejected", "withdrawn", "developer_rejected"],
                         "dry_run_states": ["waiting_for_review", "in_review", "rejected"]}),
            _step("review_android", "Google Play review", "watch", after=["promote_android"], platforms=["android"],
                  description="Watches the production track. Google Play's API can't say when an update is live, so after review it reports unknown: then you confirm it in Play Console.",
                  done="versionCode {android_version_code} is live.",
                  outcomes=[_o("live", "success"), _o("rejected", "failure"), _o("halted", "failure")],
                  routes=[_r("live", "next"), _r("rejected", "ask_owner"), _r("halted", "ask_owner")],
                  watch={"adapter": {"command": "{play_status_command} --track production --version-code {android_version_code}"},
                         "interval_s": 900, "backoff": 1.0, "max_interval_s": 3600, "timeout_h": 24 * 7,
                         "state_map": {"live": "live", "completed": "live", "rejected": "rejected", "halted": "halted"},
                         "terminal_states": ["live", "completed", "rejected", "halted"],
                         "owner_states": ["unknown"],
                         "owner_hint": "Google Play's API can't say whether versionCode {android_version_code} is live. Only you can confirm it: check Play Console.",
                         "dry_run_states": ["in_review", "unknown"]}),
        ]},
        {"key": "resubmit", "title": "Fix and resubmit", "steps": [
            _step("fix_rejection", "Fix what App Review rejected", "agent", role="engineer", after=["review_ios"], platforms=["ios"],
                  description="Read the rejection in App Store Connect and fix it: code in a small PR with tests, or the metadata. Post what changed and why it answers the reviewer.",
                  done="The fix is in an open PR (or the metadata is updated), with the rejection reason quoted."),
            _step("merge_fix", "Review and merge the fix", "person", role="owner", after=["fix_rejection"], platforms=["ios"],
                  description="Review the fix and merge it. For a metadata-only fix, say so.",
                  done="The fix is merged, or it was metadata only.",
                  outcomes=[_o("merged", "success")], routes=[_r("merged", "next")]),
            _step("rebuild_ios", "New iOS build and upload", "agent", role="release", after=["merge_fix"], platforms=["ios"],
                  description="Bump the iOS build number past {build}, archive {version} from the merged commit, run the pre-upload scans and upload. Post the new build number.",
                  done="The new build is uploaded; its build number and the scans' output are posted.",
                  resources=["build:heavy"], secrets=["ASC_KEY"]),
            _step("processing_resubmit", "Wait for the new build to process", "watch", after=["rebuild_ios"], platforms=["ios"],
                  description="Watches App Store Connect until the newest build of {version} is VALID.",
                  done="The new build is VALID.",
                  outcomes=[_o("valid", "success"), _o("invalid", "failure")],
                  routes=[_r("valid", "next"), _r("invalid", "ask_owner")],
                  watch={"adapter": {"command": "{asc_status_command} --what build --version {version}"},
                         "interval_s": 120, "backoff": 1.2, "max_interval_s": 600, "timeout_h": 3,
                         "state_map": {"valid": "valid", "invalid": "invalid", "failed": "invalid"},
                         "terminal_states": ["valid", "invalid", "failed"],
                         "dry_run_states": ["processing", "valid"]}),
            _qa("qa_resubmit_ios", "ios", "subset", ["processing_resubmit"], False) | {
                "title": "Check the fix on iOS",
                "qa": {"kind": "check", "platform": "ios", "focus": "The fix for the App Review rejection and the screens it touched."},
                "description": "The screens the fix touched, plus every open finding, on a debug build of the merged commit pointed at {qa_target_env}.",
                "dry_run": {"outcomes": ["pass"], "note": ""}},
            _step("gate_resubmit", "Your go-ahead to resubmit", "gate", role="owner", after=["qa_resubmit_ios"], platforms=["ios"],
                  description="The proof for the fixed build. Nothing goes back to App Review before you say Go here.",
                  done="You chose Go or No-go, with a reason for No-go.",
                  outcomes=[_o("go", "success"), _o("no_go", "failure")],
                  routes=[_r("go", "next"), _r("no_go", "stop")],
                  gate={"proof_steps": ["qa_resubmit_ios", "qa_full_ios"], "include_unit_only": True}),
            _step("resubmit_ios", "Resubmit for App Review", "agent", role="release", after=["gate_resubmit"], platforms=["ios"],
                  irreversible=True, outward="App Store",
                  description="Attach the new build to version {version}, answer the reviewer in Resolution Center, keep the release type {release_type}, and submit.",
                  done="Version {version} is Waiting for Review with the new build.", secrets=["ASC_KEY"]),
            _step("review_resubmit_ios", "App Store review, again", "watch", after=["resubmit_ios"], platforms=["ios"],
                  description="Watches App Review for the resubmitted build.",
                  done="Version {version} is approved, or you decided what a new rejection means.",
                  outcomes=[_o("approved", "success"), _o("live", "success"), _o("rejected", "failure"), _o("resubmit", "changes")],
                  routes=[_r("approved", "exit_group"), _r("live", "exit_group"), _r("rejected", "ask_owner"),
                          _r("resubmit", "return", "fix_rejection")],
                  watch={"adapter": {"command": "{asc_status_command} --what review --version {version}"},
                         "interval_s": 900, "backoff": 1.0, "max_interval_s": 1800, "timeout_h": 24 * 7,
                         "state_map": {"approved": "approved", "pending_developer_release": "approved",
                                       "ready_for_sale": "live", "live": "live", "rejected": "rejected",
                                       "metadata_rejected": "rejected"},
                         "terminal_states": ["approved", "pending_developer_release", "ready_for_sale", "live",
                                             "rejected", "metadata_rejected", "withdrawn", "developer_rejected"],
                         "dry_run_states": ["waiting_for_review", "in_review", "approved"]}),
        ]},
        {"key": "release", "title": "Release", "steps": [
            _step("release_ios", "Release it on the App Store", "person", role="owner",
                  after=["review_ios", "review_resubmit_ios"], platforms=["ios"],
                  keep_after=["review_ios", "review_resubmit_ios"],
                  when={"param": "release_type", "equals": "manual"},
                  description="Version {version} is approved and waits for you (manual release). Release it in App Store Connect when you're ready, then say so here.",
                  done="You pressed Release in App Store Connect.",
                  outcomes=[_o("released", "success")], routes=[_r("released", "next")]),
            _step("live_ios", "Check it's live on the App Store", "watch", after=["release_ios"], platforms=["ios"],
                  keep_after=["review_ios", "review_resubmit_ios"],
                  description="Watches until version {version} is Ready for Sale.",
                  done="Version {version} is Ready for Sale.",
                  outcomes=[_o("live", "success")], routes=[_r("live", "next")],
                  watch={"adapter": {"command": "{asc_status_command} --what review --version {version}"},
                         "interval_s": 300, "backoff": 1.2, "max_interval_s": 1800, "timeout_h": 48,
                         "state_map": {"ready_for_sale": "live", "live": "live"},
                         "terminal_states": ["ready_for_sale", "live", "removed_from_sale", "developer_removed_from_sale"],
                         "dry_run_states": ["pending_developer_release", "ready_for_sale"]}),
        ]},
        {"key": "close", "title": "Live and close", "steps": [
            _step("live_check", "Check what is live", "agent", role="release",
                  after=["live_ios", "review_android", "deploy_web_prod"],
                  description="Confirm the live versions in each store and in production, and run a short smoke check of the live build.",
                  done="The live versions are posted with a smoke-check result."),
            _step("close", "Release notes and history", "agent", role="release", after=["live_check"],
                  description="Record the release: versions, build ids, QA run links, decision times. Clean up worktrees, branches and test tokens.",
                  done="The release history is written and the clean-up is done."),
        ]},
    ]
    return {
        "schema": TEMPLATE_SCHEMA,
        "key": "mobile_app_release",
        "name": "Mobile App Release",
        "version": 2,
        "icon": "rocket",
        "tone": "amber",
        "description": "Intake to live for the App Store, Google Play, a website and an API: fix loop, full regression, your go/no-go with proof, store review watched for you.",
        "goal": "Ship {release_label} on {platform_words}, with proof before anything reaches a store.",
        "title": "Release {release_label}",
        "execution_mode": "parallel",
        "parameters": [
            {"key": "platforms", "label": "Platforms", "type": "platforms", "default": ["ios", "android", "web", "api"], "required": True},
            {"key": "version", "label": "Version", "type": "text", "placeholder": "1.0.2", "required": True,
             "help": "The marketing version on iOS, the website and the API."},
            {"key": "build", "label": "iOS build", "type": "text", "placeholder": "8", "required": True, "platform": "ios"},
            {"key": "android_version", "label": "Android version", "type": "text", "placeholder": "1.0.20", "platform": "android",
             "help": "Leave empty to use the same version as iOS."},
            {"key": "android_version_code", "label": "Android versionCode", "type": "text", "placeholder": "20", "required": True,
             "platform": "android"},
            {"key": "release_type", "label": "iOS release", "type": "choice", "required": True, "platform": "ios",
             "choices": [{"value": "after_approval", "label": "Automatically after approval"},
                         {"value": "manual", "label": "Manually, when I release it"}],
             "help": "Asked every version, never defaulted."},
            {"key": "android_rollout", "label": "Android rollout", "type": "choice", "default": "100%", "platform": "android",
             "choices": [{"value": "100%", "label": "Everyone"}, {"value": "50%", "label": "50%"},
                         {"value": "20%", "label": "20%"}, {"value": "5%", "label": "5%"}]},
            {"key": "qa_target_env", "label": "QA environment", "type": "text", "default": "staging"},
            {"key": "batch_summary", "label": "What's in this release", "type": "longtext", "default": "",
             "placeholder": "Broker fee shows as a percentage; faster listing photos"},
            {"key": "qa_subset_tags", "label": "Scenario tags for the changed screens", "type": "text", "default": ""},
            {"key": "coverage_threshold", "label": "Coverage warning below", "type": "number", "default": 10,
             "help": "Validated scenarios a platform needs before the proof stops warning."},
            {"key": "asc_status_command", "label": "App Store status command", "type": "text",
             "default": "python3 scripts/release-adapters/asc_status.py", "platform": "ios", "advanced": True,
             "help": "Run from the project root without a shell: ~ and $VARS are not expanded, so use absolute paths."},
            {"key": "inventory_command", "label": "Release inventory command", "type": "text",
             "default": "python3 scripts/release-adapters/release_inventory.py", "advanced": True,
             "help": "Fills the Release home: what's live, in review, merged since the last release, and the next versions. Same rules: no shell, absolute paths."},
            {"key": "play_status_command", "label": "Google Play status command", "type": "text",
             "default": "python3 scripts/release-adapters/play_status.py", "platform": "android", "advanced": True,
             "help": "Run from the project root without a shell: ~ and $VARS are not expanded, so use absolute paths."},
        ],
        "roles": [
            {"key": "owner", "label": "Owner (holds the gates)", "kind": "human"},
            {"key": "engineer", "label": "Engineer", "kind": "ai"},
            {"key": "release", "label": "Release", "kind": "ai"},
            {"key": "qa", "label": "QA", "kind": "ai"},
        ],
        "stages": stages,
        "repeat_groups": [
            {"name": "Fix loop", "member_tasks": ["implement", "review_merge", "deploy_api_staging", "deploy_web_staging",
                                                  "qa_subset_ios", "qa_subset_android", "qa_subset_web", "triage_subset"],
             "review_task": "triage_subset", "exit_outcome": "clear", "max_rounds": 3},
            {"name": "Regression loop", "member_tasks": ["bump", "qa_build", "qa_full_ios", "qa_full_android",
                                                         "qa_full_web", "triage_full"],
             "review_task": "triage_full", "exit_outcome": "clear", "max_rounds": 2},
            {"name": "Approval loop", "member_tasks": ["build_ios", "processing_ios", "build_android",
                                                       "testflight_owner", "gate"],
             "review_task": "gate", "exit_outcome": "go", "max_rounds": 3},
            {"name": "Resubmit loop", "member_tasks": ["fix_rejection", "merge_fix", "rebuild_ios", "processing_resubmit",
                                                       "qa_resubmit_ios", "gate_resubmit", "resubmit_ios", "review_resubmit_ios"],
             "review_task": "review_resubmit_ios", "exit_outcome": "approved", "max_rounds": 3},
        ],
    }


def _from_preset(key, name, description, draft, icon, tone) -> dict:
    """A QA preset (qa_blocks) as a template: one stage a step, the same flow."""
    stages = []
    for t in draft["tasks"]:
        stages.append({"key": t["client_key"], "title": t["title"], "steps": [{
            "client_key": t["client_key"], "title": t["title"],
            "kind": "qa" if t.get("qa") else "agent", "role": "qa" if t.get("qa") else "engineer",
            "after": list(t.get("depends_on") or []), "platforms": [], "required": False,
            "description": t.get("description", ""), "definition_of_done": t.get("definition_of_done", ""),
            "outcomes": t.get("outcomes") or [], "routes": t.get("routes") or [],
            **({"qa": t["qa"]} if t.get("qa") else {}),
            "dry_run": {"outcomes": ["fail", "pass"] if (t.get("qa") or {}).get("kind") == "check" else
                        ["fix", "clear"] if (t.get("qa") or {}).get("kind") == "triage" else []},
        }]})
    return {
        "schema": TEMPLATE_SCHEMA, "key": key, "name": name, "version": 1, "icon": icon, "tone": tone,
        "description": description, "goal": draft.get("goal") or description, "title": name,
        "execution_mode": draft.get("execution_mode", "serial"),
        "parameters": [{"key": "focus", "label": "What to build", "type": "longtext", "default": ""}],
        "roles": [{"key": "owner", "label": "Owner", "kind": "human"},
                  {"key": "engineer", "label": "Engineer", "kind": "ai"},
                  {"key": "qa", "label": "QA", "kind": "ai"}],
        "stages": stages, "repeat_groups": copy.deepcopy(draft.get("repeat_groups") or []),
    }


def builtins(cur=None, cid=None) -> list[dict]:
    """Built-in templates, Mobile App Release first. The QA presets join when Quality is on."""
    out = [mobile_app_release()]
    try:
        from portal_backend import qa_blocks

        for preset in (qa_blocks.presets(cur, cid) if cur is not None and cid else []):
            draft = preset.get("draft") or preset
            if not draft.get("tasks"):
                continue
            out.append(_from_preset(
                f"preset_{preset.get('key', 'qa')}", preset.get("name") or draft.get("title") or "Build, QA, fix",
                preset.get("summary") or preset.get("description") or "Build, check with Quality, fix until it passes.",
                draft, "loop", "green",
            ))
    except Exception:  # noqa: BLE001 - Quality may be off or its presets shaped differently
        pass
    return out


# ---- validation -----------------------------------------------------------------


def all_steps(template) -> list[dict]:
    return [s for stage in template.get("stages", []) for s in stage.get("steps", [])]


def validate_template(template: dict) -> None:
    if not isinstance(template, dict):
        conflict("template_invalid", "A template is a JSON object.", status=422)
    for field in ("key", "name", "stages"):
        if not template.get(field):
            conflict("template_invalid", f"A template needs {field}.", status=422)
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,79}", str(template["key"])):
        conflict("template_invalid", "A template key is lowercase letters, digits, - and _.", status=422)
    keys = [s.get("client_key") for s in all_steps(template)]
    if not keys or len(set(keys)) != len(keys) or not all(isinstance(k, str) and k for k in keys):
        conflict("template_invalid", "Every step needs a distinct client_key.", status=422)
    known = set(keys)
    for s in all_steps(template):
        if s.get("kind", "agent") not in {"agent", "person", "qa", "watch", "gate"}:
            conflict("template_invalid", f"Unknown step kind for {s['client_key']}.", status=422)
        if set(s.get("after") or []) - known:
            conflict("template_invalid", f"{s['client_key']} waits for a step that isn't in the template.", status=422)
    if len(json.dumps(template)) > 400_000:
        conflict("template_invalid", "The template is too large.", status=422)


# ---- compiling ------------------------------------------------------------------


def _fill(text, params) -> str:
    def sub(m):
        v = params.get(m.group(1))
        # A value not chosen yet reads as an ellipsis, never as a raw {placeholder}.
        return "…" if v is None or v == "" else str(v)
    return re.sub(r"\{([a-z_]+)\}", sub, str(text or ""))


def _fill_obj(value, params):
    if isinstance(value, str):
        return _fill(value, params)
    if isinstance(value, list):
        return [_fill_obj(v, params) for v in value]
    if isinstance(value, dict):
        return {k: _fill_obj(v, params) for k, v in value.items()}
    return value


def _label_word(label: str) -> str:
    """"Version" reads "version" mid-sentence; "iOS build" and "Android versionCode" keep their case."""
    return label if any(c.isupper() for c in label[1:]) else label.lower()


def resolve_params(template, params) -> tuple[dict, list[dict]]:
    """Defaults filled in, and a problem for each required parameter left empty."""
    out, problems = {}, []
    chosen = params.get("platforms") or next(
        (p.get("default") for p in template.get("parameters", []) if p["key"] == "platforms"), list(PLATFORMS)
    )
    for p in template.get("parameters", []):
        value = params.get(p["key"], p.get("default"))
        out[p["key"]] = value
        applies = not p.get("platform") or p["platform"] in (chosen or [])
        if p.get("required") and applies and (value is None or value == "" or value == []):
            problems.append({"code": "parameter_required", "param": p["key"],
                             "message": f"Choose {_label_word(p['label'])}."})
    for k, v in params.items():
        out.setdefault(k, v)
    out["platforms"] = [p for p in PLATFORMS if p in (out.get("platforms") or [])]
    out["platform_words"] = ", ".join(PLATFORM_WORD[p] for p in out["platforms"]) or "no platform"
    if out.get("release_type"):
        out["release_type_words"] = {"after_approval": "automatic release after approval",
                                     "manual": "manual release"}.get(out["release_type"], out["release_type"])
    ios_v, ios_b = str(out.get("version") or "").strip(), str(out.get("build") or "").strip()
    and_v = str(out.get("android_version") or "").strip() or ios_v
    and_c = str(out.get("android_version_code") or "").strip()
    out["android_version"] = and_v
    ios_word = f"{ios_v or '…'} ({ios_b or '…'})"
    and_word = f"{and_v or '…'} ({and_c or '…'})"
    has_ios, has_android = "ios" in out["platforms"], "android" in out["platforms"]
    if has_ios and has_android:
        out["release_label"] = ios_word if (ios_v, ios_b) == (and_v, and_c) else f"iOS {ios_word} · Android {and_word}"
        out["versions_detail"] = f"iOS {ios_v or '…'} build {ios_b or '…'} and Android {and_v or '…'} versionCode {and_c or '…'}"
    elif has_ios:
        out["release_label"], out["versions_detail"] = ios_word, f"iOS {ios_v or '…'} build {ios_b or '…'}"
    elif has_android:
        out["release_label"], out["versions_detail"] = and_word, f"Android {and_v or '…'} versionCode {and_c or '…'}"
    else:
        out["release_label"] = out["versions_detail"] = ios_v or "…"
    if not str(out.get("batch_summary") or "").strip():
        out["batch_summary"] = "the batch the owner listed in Intake"
    return out, problems


def _ancestors_of(key: str, by_key: dict) -> set[str]:
    """Every step `key` waits for, directly or not, in the template as written."""
    seen, todo = set(), list(by_key.get(key, {}).get("after") or [])
    while todo:
        k = todo.pop()
        if k in seen or k not in by_key:
            continue
        seen.add(k)
        todo.extend(by_key[k].get("after") or [])
    return seen


def _descendants_in(key: str, deps: dict[str, list[str]]) -> set[str]:
    out, todo = set(), [key]
    while todo:
        k = todo.pop()
        for d, prereqs in deps.items():
            if k in prereqs and d not in out:
                out.add(d)
                todo.append(d)
    return out


def _requirement(step, ships: bool) -> bool:
    req = step.get("required")
    return bool(req is True or (req == "if_ship" and ships))


def _reduce(deps: dict[str, list[str]]) -> dict[str, list[str]]:
    """Drop a prerequisite another prerequisite already waits for (transitive reduction)."""
    from portal_backend.workflow_graph import ancestors

    out = {}
    for k, prereqs in deps.items():
        keep = []
        for p in prereqs:
            if not any(p != q and p in ancestors(q, deps) for q in prereqs):
                keep.append(p)
        out[k] = sorted(set(keep), key=keep.index)
    return out


def compile_template(template: dict, params: dict, removed=(), added=(), *, dry_run=False,
                     roles: dict | None = None, owner_id: str | None = None) -> dict:
    """{draft, steps, stages, problems}: the WorkflowDraft to create, and what the editor shows."""
    validate_template(template)
    values, problems = resolve_params(template, params or {})
    roles = roles or {}
    chosen = set(values["platforms"])
    removed = set(removed or [])
    steps = [copy.deepcopy(s) for s in all_steps(template)]
    stage_of = {s["client_key"]: st for st in template["stages"] for s in st["steps"]}
    for a in added or []:
        a = copy.deepcopy(a)
        anchor = a.pop("insert_after", None)
        if not a.get("client_key") or any(s["client_key"] == a["client_key"] for s in steps):
            conflict("step_key", "Each added step needs a new key.", status=422)
        if anchor:
            for s in steps:
                if anchor in (s.get("after") or []):
                    s["after"] = [a["client_key"] if x == anchor else x for x in s["after"]]
            a["after"] = [anchor]
            stage_of[a["client_key"]] = stage_of.get(anchor, template["stages"][-1])
            at = next(i for i, s in enumerate(steps) if s["client_key"] == anchor)
            steps.insert(at + 1, a)
        else:
            stage_of[a["client_key"]] = template["stages"][-1]
            steps.append(a)
        a.setdefault("kind", "agent")
        a["added"] = True
    by_key = {s["client_key"]: s for s in steps}

    def condition_ok(s):
        cond = s.get("when")
        return not cond or values.get(cond.get("param")) == cond.get("equals")

    def platform_ok(s):
        return (not s.get("platforms") or bool(chosen & set(s["platforms"]))) and condition_ok(s)

    def ships_with(keep):
        return any(by_key[k].get("irreversible") for k in keep)

    keep = [s["client_key"] for s in steps if platform_ok(s)]
    ships = ships_with([k for k in keep if k not in removed])
    locked = {}
    for k in keep:
        if _requirement(by_key[k], ships):
            locked[k] = ("Required while this release ships to a store or production."
                         if by_key[k].get("required") == "if_ship" else "Every release needs this step.")
    for k in sorted(removed & set(locked)):
        problems.append({"code": "step_required", "task_id": k, "message": locked[k]})
    keep = [k for k in keep if k not in removed or k in locked]
    kept = set(keep)

    # Reconnect around what was removed: a step waits for the nearest kept prerequisites.
    memo: dict[str, list[str]] = {}

    def kept_before(k, seen=()):
        if k in memo:
            return memo[k]
        out = []
        for p in by_key[k].get("after") or []:
            if p not in by_key or p in seen:
                continue
            out.extend([p] if p in kept else kept_before(p, seen + (k,)))
        memo[k] = list(dict.fromkeys(out))
        return memo[k]

    deps = _reduce({k: kept_before(k) for k in keep})
    for k in keep:
        for p in by_key[k].get("keep_after") or []:
            if p in kept and p not in deps[k] and p not in _descendants_in(k, deps):
                deps[k].append(p)
    for k, d in deps.items():
        if len(d) > 3:
            problems.append({"code": "dependency_limit", "task_id": k,
                             "message": f"{by_key[k]['title']} would wait for more than three steps."})

    # Loops: keep the members still here; a loop without its review step, or with fewer than
    # two steps, dissolves.
    groups = []
    for g in template.get("repeat_groups") or []:
        members = [m for m in g["member_tasks"] if m in kept]
        if g["review_task"] in kept and len(members) >= 2:
            groups.append({**copy.deepcopy(g), "member_tasks": members})
    reviews = {g["review_task"]: g for g in groups}
    member_of = {m: g for g in groups for m in g["member_tasks"]}

    tasks, view = [], []
    owner = roles.get("owner") or owner_id
    for order, k in enumerate(keep):
        s = by_key[k]
        kind = s.get("kind", "agent")
        outcomes = [dict(o) for o in s.get("outcomes") or []]
        routes = []
        for r in s.get("routes") or []:
            r = dict(r)
            dest = r.get("destination")
            if dest in {"return", "exit_group"} and k not in reviews:
                r = {"outcome": r["outcome"], "destination": "next" if dest == "exit_group" else "ask_owner"}
            elif dest == "return":
                g = reviews[k]
                target = r.get("destination_task")
                if target not in g["member_tasks"] or target == k:
                    target = next(m for m in g["member_tasks"] if m != k)
                r["destination_task"] = target
            elif dest == "step" and r.get("destination_task") not in kept:
                # The branch's step was left out: go to the kept step that took its place.
                target = r.get("destination_task")
                instead = next((d for d in keep if k in deps.get(d, []) and target in _ancestors_of(d, by_key)), None)
                r = ({"outcome": r["outcome"], "destination": "step", "destination_task": instead} if instead
                     else {"outcome": r["outcome"], "destination": "next"})
            routes.append(r)
        gate = copy.deepcopy(s.get("gate"))
        if kind == "gate" and k not in reviews:
            # No loop before the gate: Send back has nowhere to go.
            outcomes = [o for o in outcomes if o["name"] != "send_back"]
            routes = [r for r in routes if r["outcome"] != "send_back"]
            gate = {**(gate or {}), "choices": [c for c in (gate or {}).get("choices", ["go", "no_go", "send_back"]) if c != "send_back"]}
        if gate:
            gate["proof_steps"] = [p for p in gate.get("proof_steps", []) if p in kept]
        role = s.get("role")
        assignee = None
        if not dry_run and kind in {"agent", "qa"}:
            assignee = roles.get(role) or None
        spec = {
            "kind": kind, "stage": stage_of[k]["key"], "stage_title": stage_of[k]["title"], "role": role,
            "person_id": owner if kind in {"person", "gate"} else None,
            "required": k in locked, "platforms": [p for p in s.get("platforms") or [] if p in PLATFORMS],
            "irreversible": bool(s.get("irreversible")), "outward": s.get("outward"),
            "resources": s.get("resources") or [], "scope": s.get("scope"),
            "secrets": s.get("secrets") or [],
            "coverage_threshold": int(values.get("coverage_threshold") or 0) if kind == "qa" else None,
        }
        if s.get("watch"):
            spec["watch"] = _fill_obj(s["watch"], values)
        if gate:
            spec["gate"] = gate
        if s.get("dry_run") is not None:
            spec["dry_run"] = {"outcomes": [o for o in s["dry_run"].get("outcomes", []) if o in {x["name"] for x in outcomes}],
                               "note": s["dry_run"].get("note", "")}
        if kind == "qa" and s.get("scope"):
            platform = (s.get("qa") or {}).get("platform")
            android = platform == "android"
            spec["build"] = {"type": "debug",
                             "version": str(values.get("android_version" if android else "version") or "") or None,
                             "build": str(values.get("android_version_code" if android else "build") or "") or None,
                             "env": values.get("qa_target_env")}
            if not platform:
                spec["build"] = None
        task = {
            "client_key": k,
            "title": _fill(s["title"], values)[:200],
            "description": _fill(s.get("description"), values)[:4000],
            "definition_of_done": _fill(s.get("definition_of_done") or s.get("done") or "Done.", values)[:4000],
            "assignee_id": assignee,
            "priority": 100 + order,
            "depends_on": deps[k][:3],
            "outcomes": outcomes,
            "routes": routes,
            "step": {kk: vv for kk, vv in spec.items() if vv not in (None, [], "")} | {"kind": kind,
                                                                                      "required": k in locked,
                                                                                      "irreversible": bool(s.get("irreversible"))},
        }
        if s.get("qa"):
            qa = {kk: vv for kk, vv in _fill_obj(s["qa"], values).items() if vv not in (None, "")}
            if s.get("scope") == "subset" and values.get("qa_subset_tags"):
                qa["tags"] = [t.strip() for t in str(values["qa_subset_tags"]).split(",") if t.strip()][:20]
            task["qa"] = qa
        tasks.append(task)
        view.append({
            "client_key": k, "title": task["title"], "kind": kind, "stage": stage_of[k]["key"],
            "role": role, "required": k in locked, "locked_reason": locked.get(k),
            "removed": False, "platforms": spec["platforms"], "irreversible": spec["irreversible"],
            "outward": spec["outward"], "done_when": task["definition_of_done"],
            "description": task["description"], "after": deps[k],
            "loop": member_of[k]["name"] if k in member_of else None,
            "branches": [{"outcome": r["outcome"], "destination": r["destination"],
                          "to": r.get("destination_task")} for r in routes if r["destination"] != "next"],
            "assignee_id": assignee, "added": bool(s.get("added")),
        })
    for s in steps:
        if s["client_key"] not in kept:
            view.append({
                "client_key": s["client_key"], "title": _fill(s["title"], values), "kind": s.get("kind", "agent"),
                "stage": stage_of[s["client_key"]]["key"], "role": s.get("role"), "required": False,
                "locked_reason": None, "removed": True,
                "removed_why": ("condition" if not condition_ok(s) else "platform") if not platform_ok(s) else "removed",
                "platforms": s.get("platforms") or [], "irreversible": bool(s.get("irreversible")),
                "outward": s.get("outward"), "done_when": _fill(s.get("definition_of_done"), values),
                "description": _fill(s.get("description"), values), "after": [], "loop": None, "branches": [],
                "assignee_id": None, "added": bool(s.get("added")),
            })
    if not dry_run:
        for t in tasks:
            kind = t["step"]["kind"]
            if kind == "agent" and not t["assignee_id"]:
                role = t["step"].get("role")
                problems.append({"code": "role_unassigned", "task_id": t["client_key"], "role": role,
                                 "message": f"Choose an agent for {role or 'this step'}."})
    draft = {
        "title": _fill(template.get("title") or template["name"], values)[:200],
        "goal": _fill(template.get("goal") or template.get("description") or template["name"], values)[:4000],
        "execution_mode": template.get("execution_mode", "parallel"),
        "semantics_version": 2,
        "tasks": tasks,
        "repeat_groups": [{k: v for k, v in g.items() if k in {"name", "member_tasks", "review_task", "exit_outcome",
                                                                 "max_rounds", "stall_rule"}} for g in groups],
        "turn_allowance": 400,
        "dry_run": bool(dry_run),
        "template": {"key": template["key"], "version": int(template.get("version") or 1), "name": template["name"],
                     "params": {k: v for k, v in (params or {}).items()}, "removed": sorted(removed)},
    }
    return {
        "draft": draft,
        "steps": view,
        "stages": [{"key": st["key"], "title": st["title"]} for st in template["stages"]],
        "loops": [{"name": g["name"], "members": g["member_tasks"], "review": g["review_task"],
                   "max_rounds": g.get("max_rounds", 5)} for g in groups],
        "parameters": template.get("parameters", []),
        "roles": template.get("roles", []),
        "values": values,
        "problems": problems,
    }


def summary(template: dict, source: str = "builtin") -> dict:
    steps = all_steps(template)
    return {
        "key": template["key"], "name": template["name"], "version": int(template.get("version") or 1),
        "description": template.get("description", ""), "icon": template.get("icon", "workflows"),
        "tone": template.get("tone", "indigo"), "source": source,
        "stage_count": len(template.get("stages", [])), "step_count": len(steps),
        "gates": sum(1 for s in steps if s.get("kind") == "gate"),
        "watches": sum(1 for s in steps if s.get("kind") == "watch"),
        "outward": sum(1 for s in steps if s.get("irreversible")),
        "base_key": template.get("base_key"), "base_version": template.get("base_version"),
        "has_inventory": any(p.get("key") == "inventory_command" and p.get("default") for p in template.get("parameters", [])),
        "thread": [{"kind": s.get("kind", "agent"), "outward": bool(s.get("irreversible")),
                    "stage": st["key"]} for st in template.get("stages", []) for s in st.get("steps", [])],
    }
