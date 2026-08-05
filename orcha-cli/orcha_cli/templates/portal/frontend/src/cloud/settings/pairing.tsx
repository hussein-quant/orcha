/**
 * ORCHA CLOUD — phone-pairing entry points, both reusing the cloud-owned
 * PairingModal (src/cloud/projects/PairingModal.tsx):
 *
 *  - PairingButton: the topbar "Pair phone" button (vanilla app-shell.js
 *    #pairPhoneBtn), registered via the Extensions.topbarActions seam —
 *    rendered between the notification pill and the autonomy switch once the
 *    open Shell consumes the seam.
 *  - PairingSection: the settings "Phone pairing" card (vanilla settings.html
 *    card + settings-key-panel.js renderPairingCard), registered via
 *    Extensions.settingsSections.
 *
 * Both open the modal against the LOADED container (vanilla openPairingModal()
 * with no opts) — cid from the snapshot scope, no project name line. The
 * trusted-lane identity rides in via the shared single-flighted fetchMe: a
 * resolved signed-in member is the only human a phone can pair as (the server
 * enforces the same rule); trust off keeps the modal's own picker semantics.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useToast } from "../../components/ui";
import { useSnapshot } from "../../state/SnapshotProvider";
import { CloudIcon } from "../projects/icons";
import { PairingModal } from "../projects/PairingModal";
import { fetchMe, type Me } from "../identity";
import "./settings-cards.css";
import "./pairing.css";

function usePairingLaunch(): { launch: () => void; modal: ReactNode } {
  const { cid } = useSnapshot();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    if (!cid) return;
    let alive = true;
    void fetchMe(cid).then((m) => { if (alive) setMe(m); });
    return () => { alive = false; };
  }, [cid]);

  const launch = () => {
    if (!cid) { toast("No Orcha container is loaded.", "danger"); return; }
    setOpen(true);
  };

  const modal = open && cid ? (
    <PairingModal
      cid={cid}
      identity={me && me.trusted ? me.identity : null}
      onClose={() => setOpen(false)}
    />
  ) : null;

  return { launch, modal };
}

/* ---- topbar action (vanilla app-shell.js #pairPhoneBtn, markup verbatim) -- */
export function PairingButton() {
  const { launch, modal } = usePairingLaunch();
  return (
    <>
      <button
        className="btn sm subtle pair-top" id="pairPhoneBtn" type="button"
        title="Pair a phone with this Orcha" onClick={launch}
      >
        <CloudIcon name="phone" cls="" />Pair phone
      </button>
      {modal}
    </>
  );
}

/* ---- settings card (vanilla renderPairingCard, markup verbatim) ----------- */
export function PairingSection() {
  const { launch, modal } = usePairingLaunch();
  return (
    <div className="card set-card">
      <div className="card-h"><h2>Phone pairing</h2></div>
      <div className="card-b">
        <div className="lead">
          Pair the Orcha mobile app with this workspace. The pairing code explains how your phone connects.
        </div>
        <div id="pairingCard">
          <div className="sc-banner muted">
            <div className="bt">
              <CloudIcon name="phone" cls="" />
              <span>Open the same pairing code that is available from the top bar.</span>
            </div>
            <button className="btn sm" id="settingsPairPhone" type="button" onClick={launch}>
              <CloudIcon name="phone" cls="" />Pair phone
            </button>
          </div>
          <div className="sc-hint">
            Your phone talks directly to this computer on your network. Nothing goes through the cloud.
          </div>
        </div>
      </div>
      {modal}
    </div>
  );
}
