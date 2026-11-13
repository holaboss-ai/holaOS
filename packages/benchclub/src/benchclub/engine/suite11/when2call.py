"""When2Call grader, deterministic layer only: did the model call a tool, and was it the expected one.

The official score asks an LLM judge (or log-probs over four answers) to tell asking a follow-up from refusing;
this grader cannot, so for request_for_info and cannot_answer items it only checks that no tool was called.
For tool_call items it checks the first call, which is the only one When2Call's own inference script keeps.
"""

from .common import FORMAT_ERROR, PASS, WRONG, verdict


def grade(item, resp):
    expected = item["answer"]["expected"]
    calls = resp["tool_calls"]
    if expected == "tool_call":
        tool = item["answer"]["tool"]
        if not calls:
            return verdict(WRONG, f"answered in text, expected a call to {tool}")
        first = calls[0]
        if first["arguments"] is None:
            return verdict(FORMAT_ERROR, f"arguments of the {first['name'] or 'unnamed'} call were not a JSON object")
        if first["name"] != tool:
            return verdict(WRONG, f"called {first['name'] or 'an unnamed tool'}, expected {tool}")
        return verdict(PASS, f"called {tool}")
    behaviour = "ask for the missing information" if expected == "request_for_info" else "say it cannot do this"
    if calls:
        return verdict(WRONG, f"called {calls[0]['name'] or 'a tool'}, expected it to {behaviour} without a tool call")
    if not resp["content"]:
        return verdict(WRONG, f"gave an empty reply, expected it to {behaviour}")
    question = " ".join(m["content"] for m in item["messages"] if m["role"] == "user")
    if _squash(resp["content"]) == _squash(question):
        return verdict(WRONG, f"repeated the question, expected it to {behaviour}")
    return verdict(PASS, f"made no tool call (expected it to {behaviour}; wording not graded)")


def _squash(text):
    return " ".join(text.split()).strip().lower()
