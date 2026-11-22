/**
 * /workflows, /workflows/new and /workflows/:id: the new screens by default. `?classic=1` keeps the
 * classic Workflows page reachable for everything it does (the engine and API are the same).
 */
import { useLocation } from "react-router-dom";
import { Shell } from "../../shell/Shell";
import { WorkflowsPage } from "../workflows/WorkflowsPage";
import { Board } from "./Board";
import { Composer } from "./Composer";
import { ReleaseHome } from "./ReleaseHome";
import { ReleaseCycle } from "./ReleaseCycle";
import { Editor } from "./Editor";
import { Run } from "./Run";
import "./flow.css";

export function WorkflowsHome() {
  const { pathname, search } = useLocation();
  const q = new URLSearchParams(search);
  // "Add this task to a workflow" (addTask) is a classic-page flow: keep it there.
  if (q.get("classic") === "1" || q.has("addTask")) return <WorkflowsPage />;
  const view = pathname === "/workflows" ? <Board /> : pathname === "/workflows/cycle" ? <ReleaseCycle key={q.get("cycle") ?? "none"} /> : pathname === "/workflows/new" ? (q.get("blank") === "1" ? <Composer /> : q.get("home") === "1" ? <ReleaseHome /> : <Editor />) : <Run key={pathname} />;
  return (
    <Shell page="workflows" title="Workflows" flush>
      <div className="fl fl-page">{view}</div>
    </Shell>
  );
}
