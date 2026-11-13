"""Reasoning Gym (reasoning-gym 0.1.25), ported to the standard library.

Each scorer reproduces the upstream `score_answer` for its dataset exactly, applied to what upstream's
`extract_answer` pulls out of the reply. Several upstream scorers give partial credit; an item passes
only at a full score of 1.0.
"""

import re

from .common import FORMAT_ERROR, PASS, WRONG, verdict

_ANSWER = re.compile(r"<answer>\s?(.*?)\s?</answer>", re.DOTALL)


def extract_answer(completion):
    """reasoning_gym.utils.extract_answer: the last <answer>…</answer> block, stripped, or None."""
    matches = list(_ANSWER.finditer(completion))
    if not matches:
        return None
    return matches[-1].group(1).strip()


def _base(answer, oracle):
    """ProceduralDataset.score_answer (used by number_sequence)."""
    if isinstance(answer, str) and len(answer) > 0:
        if answer == oracle:
            return 1.0
        if oracle in answer:
            return len(oracle) / len(answer)
    return 0.0


_GSM_NUMBER = re.compile(r"\b-?\d+(?:\.\d+)?\b")


def _gsm_symbolic(answer, oracle):
    if answer is None:
        return 0.0
    try:
        match = _GSM_NUMBER.search(answer)
        if not match:
            return 0.0
        return 1.0 if float(match.group(0)) == float(oracle) else 0.01
    except Exception:
        return 0.0


_KK_ROLES = {"knight", "knave", "pioneer", "laggard", "saint", "sinner", "hero", "villain", "angel", "devil",
             "altruist", "egoist", "sage", "fool"}


def _kk_normalize(answer):
    answer = answer.lower().strip().replace(".", " ").replace(",", " ").replace(")", " ").replace("(", " ")
    parts = [p.strip() for p in answer.replace(" and ", " ").split()]
    assignments = set()
    current_name = None
    for part in parts:
        if part in ["is", "a", "an"]:
            continue
        if part in _KK_ROLES:
            if current_name:
                assignments.add((current_name, part))
                current_name = None
        else:
            current_name = part
    return assignments


def _knights_knaves(answer, oracle):
    if not isinstance(answer, str) or len(answer) == 0:
        return 0.0
    try:
        want = _kk_normalize(oracle)
        got = _kk_normalize(answer)
        if want == got:
            return 1.0
        if len(want) == len(got):
            matching = len(want.intersection(got))
            if matching > 0:
                return 0.3 + (0.7 * matching / len(want))
    except Exception:
        pass
    return 0.0


_DIRS = {"right": (0, 1), "down": (1, 0), "left": (0, -1), "up": (-1, 0)}


def _valid_path(matrix, path):
    rows, cols = len(matrix), len(matrix[0])
    start = next((r, c) for r in range(rows) for c in range(cols) if matrix[r][c] == "*")
    end = next((r, c) for r in range(rows) for c in range(cols) if matrix[r][c] == "#")
    r, c = start
    for direction in path:
        if direction not in _DIRS:
            return False
        dr, dc = _DIRS[direction]
        r, c = r + dr, c + dc
        if not (0 <= r < rows and 0 <= c < cols):
            return False
        if matrix[r][c] == "X":
            return False
    return (r, c) == end


def _shortest_path(answer, oracle, matrix):
    if isinstance(answer, str) and len(answer) > 0:
        oracle = oracle.strip()
        answer = answer.strip()
        if answer == oracle:
            return 1.0
        steps = answer.split()
        if _valid_path(matrix, steps) and len(steps) == len(oracle.split()):
            return 1.0
        if _valid_path(matrix, steps):
            return 0.5
    return 0.0


def _zebra_puzzles(answer, oracle):
    if isinstance(answer, str) and answer.lower().replace("\n", "") == oracle.lower().replace("\n", ""):
        return 1.0
    return 0.0


def _mini_sudoku(answer, oracle, solution):
    if not isinstance(answer, str) or len(answer) == 0:
        return 0.0
    size = len(solution[0])
    if "\n".join(ln.rstrip() for ln in answer.split("\n")) == "\n".join(ln.rstrip() for ln in oracle.split("\n")):
        reward = 1.0
    else:
        row = 0
        matching = 0
        for ln in answer.split("\n"):
            if row >= len(solution):
                break
            numbers = [int(ch) for ch in ln if ch in "123456789"]
            if len(numbers) != size:
                continue
            for a, b in zip(solution[row], numbers):
                if a == b:
                    matching += 1
            row += 1
        reward = matching / (size * size)
        reward *= 0.9
    if len(answer) > len(oracle):
        reward *= len(oracle) / len(answer)
    return reward


def score(answer, spec):
    """Upstream score_answer(answer, entry) for the item's dataset, 0.0–1.0."""
    task, oracle = spec["task"], spec["oracle"]
    if task == "gsm_symbolic":
        return _gsm_symbolic(answer, oracle)
    if task == "knights_knaves":
        return _knights_knaves(answer, oracle)
    if task == "shortest_path":
        return _shortest_path(answer, oracle, spec["matrix"])
    if task == "number_sequence":
        return _base(answer, oracle)
    if task == "zebra_puzzles":
        return _zebra_puzzles(answer, oracle)
    if task == "mini_sudoku":
        return _mini_sudoku(answer, oracle, spec["solution"])
    raise ValueError(f"unknown reasoning task {task!r}")


def _short(text, limit=60):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def grade(item, resp):
    spec = item["answer"]
    answer = extract_answer(resp["content"])
    if answer is None:
        return verdict(FORMAT_ERROR, "no <answer>…</answer> block in the reply")
    points = score(answer, spec)
    expected = _short(spec["oracle"])
    if points >= 1.0:
        return verdict(PASS, f"answered '{_short(answer)}'")
    if points > 0:
        return verdict(WRONG, f"answered '{_short(answer)}', partial credit {points:.2f}; expected '{expected}'")
    return verdict(WRONG, f"answered '{_short(answer)}', expected '{expected}'")
