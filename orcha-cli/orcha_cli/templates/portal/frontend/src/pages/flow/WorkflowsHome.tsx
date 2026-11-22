/**
 * /workflows, /workflows/new and /workflows/:id: the new screens by default. `?classic=1` keeps the
 * classic Workflows page reachable for everything it does (the engine and API are the same).
 */
import { useLocation } from "react-router-dom";
import { Shell } from "../../shell/Shell";
import { WorkflowsPage } from "../workflows/WorkflowsPage";
import { Board } from "./Board";
import { Editor } from "./Editor";
import { Run } from "./Run";
import "./flow.css";

export function WorkflowsHome() {
  const { pathname, search } = useLocation();
  if (new URLSearchParams(search).get("classic") === "1") return <WorkflowsPage />;
  const view = pathname === "/workflows" ? <Board /> : pathname === "/workflows/new" ? <Editor /> : <Run key={pathname} />;
  return (
    <Shell page="workflows" title="Workflows" flush>
      <div className="fl fl-page">{view}</div>
    </Shell>
  );
}
