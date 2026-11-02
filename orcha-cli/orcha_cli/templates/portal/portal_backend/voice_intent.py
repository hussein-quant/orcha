"""The rules for decisions Talk proposes on "needs you" items (GH #409).

Which decisions each kind of item takes, which ones need text (a reason, feedback, an answer),
the read-back the owner hears before confirming, and the words that make an approval
sensitive: a plan or step that mentions merging, deploying, publishing or submitting for review
needs the spoken confirm phrase before an approve/accept goes through.
"""

from __future__ import annotations

import re
from typing import Optional

DECISIONS = {
    "plan": ("approve_plan", "reject_plan"),
    "verify": ("accept", "send_back"),
    "request": ("answer",),
}
NEEDS_TEXT = {"reject_plan": "reason", "send_back": "feedback", "answer": "answer"}
CONFIRMABLE = ("approve_plan", "accept")  # what a sensitive item gates behind the confirm phrase
MAX_TEXT = 4000

SENSITIVE = re.compile(
    r"\b(merg(?:e|es|ed|ing)|deploy(?:s|ed|ing|ment)?|publish(?:es|ed|ing)?|"
    r"submit(?:s|ted|ting)? for review|app store|play store|testflight|push(?:es|ed|ing)? to main|"
    r"production|prod release|release to prod)\b",
    re.IGNORECASE,
)


def sensitive_words(*texts: Optional[str]) -> list[str]:
    found: list[str] = []
    for text in texts:
        for m in SENSITIVE.finditer(text or ""):
            w = m.group(0).lower()
            if w not in found:
                found.append(w)
    return found


MISSING_TEXT = {
    "reject_plan": "What should change in the plan?",
    "send_back": "What should they fix?",
    "answer": "What's your answer?",
}


def _read_back(action: str, text: Optional[str]) -> str:
    text = text.strip().rstrip(".!?") if text else None  # the sentence adds its own full stop
    quote = f": {text}" if text else ""
    return {
        "approve_plan": "Approving the plan" + (f", with the note: {text}" if text else "") + ".",
        "reject_plan": f"Sending the plan back{quote}.",
        "accept": "Accepting the work" + (f", with the note: {text}" if text else "") + ".",
        "send_back": f"Sending it back{quote}.",
        "answer": f"Answering{quote}.",
    }.get(action, "")
