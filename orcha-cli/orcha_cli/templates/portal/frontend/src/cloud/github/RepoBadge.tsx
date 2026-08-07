/**
 * RepoBadge — renders a container's bound repo two ways (Orcha Cloud local
 * run, Addendum 2 deliverable 2): a normal binding is the owner/name text
 * (optionally linked to github.com); a LOCAL binding ("local") renders as
 * the workspace name plus a small "Local" chip instead — never a link to
 * a repo literally called "local" on github.com.
 *
 * Used wherever a bound repo full_name surfaces: the GitHub page header,
 * project cards (ProjectsPage), and any future Code Space anchor that wants
 * the same treatment.
 */
import { Icon } from "../../components/ui";
import { CloudIcon } from "../projects/icons";
import { isLocalRepo, repoDisplayName } from "./connectRepo";

export interface RepoBadgeProps {
  repo: string | null | undefined;
  /** workspace/project display name, used as the local label when known. */
  workspaceName?: string | null;
  /** render the GitHub full_name as a clickable github.com link (never for local). */
  link?: boolean;
  className?: string;
}

export function RepoBadge({ repo, workspaceName, link, className }: RepoBadgeProps) {
  if (!repo) return null;
  const local = isLocalRepo(repo);
  const cls = "repo-badge" + (local ? " local" : "") + (className ? " " + className : "");
  if (local) {
    return (
      <span className={cls} data-repo-kind="local" title="Local git repository — works offline, no GitHub needed">
        <CloudIcon name="folder" cls="" />
        <span className="repo-badge-name">{repoDisplayName(repo, workspaceName)}</span>
        <span className="repo-badge-chip">Local</span>
      </span>
    );
  }
  const label = <><Icon name="link" cls="" />{repo}</>;
  return (
    <span className={cls} data-repo-kind="github" title={repo}>
      {link ? (
        <a href={`https://github.com/${repo}`} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : label}
    </span>
  );
}
