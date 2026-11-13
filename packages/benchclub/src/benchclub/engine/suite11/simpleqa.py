"""SimpleQA Verified: short factual questions, matched against the gold answer by rule.

The upstream grader is an LLM autorater; this one is stricter on purpose. Every accepted form is derived
from the gold string alone: names must appear in full (accents, case and punctuation aside), numbers must
equal the gold or fall inside its stated acceptable range, dates must carry the same year (and month and day
when the gold has them). For numbers and dates the first one the reply gives, ignoring any already in the
question, is the answer, so a hedge like "1998 or 1999" never earns credit. A reply that says it does not
know and offers no guess is `abstained`.
"""

import re
import unicodedata

from .common import ABSTAINED, PASS, WRONG, verdict

_FOLD = str.maketrans({"ð": "d", "Ð": "d", "þ": "th", "Þ": "th", "ø": "o", "Ø": "o", "æ": "ae", "Æ": "ae",
                       "œ": "oe", "Œ": "oe", "ß": "ss", "ł": "l", "Ł": "l", "đ": "d", "Đ": "d", "ı": "i"})
_ARTICLE = re.compile(r"\b(?:a|an|the)\b(?!\.)")
_TITLES = {"sir", "dame", "lord", "lady", "colonel", "col", "general", "gen", "major", "captain", "capt",
           "admiral", "dr", "doctor", "professor", "prof", "mr", "mrs", "ms", "rev", "reverend"}
_MONTHS = {}
for _i, _name in enumerate(("january", "february", "march", "april", "may", "june", "july", "august",
                            "september", "october", "november", "december"), 1):
    _MONTHS[_name] = _i
    _MONTHS[_name[:3]] = _i
_MONTHS["sept"] = 9
_SMALL = {w: i for i, w in enumerate((
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"))}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80,
         "ninety": 90}
_SCALE = {"thousand": 1e3, "million": 1e6, "billion": 1e9, "bn": 1e9, "trillion": 1e12}
_NUMBER = re.compile(
    r"(?<![\w.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?!\w)(?:\s*(thousand|million|billion|trillion|bn)\b)?",
    re.IGNORECASE)
_WORD_NUMBER = re.compile(r"\b(" + "|".join(_TENS) + r")(?:[\s-](" + "|".join(list(_SMALL)[1:10]) + r"))?\b|\b("
                          + "|".join(_SMALL) + r")\b", re.IGNORECASE)
_RANGE = re.compile(r"\(acceptable range:\s*anything between\s+(.+?)\s+and\s+(.+?)\)", re.IGNORECASE)
_ISO_DATE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")

_ABSTAIN = re.compile(
    r"\b(i\s+(?:do\s*n[o']?t|don't|dont)\s+know|i\s*(?:'m|am)\s+not\s+(?:sure|certain|aware)|not\s+sure|unsure"
    r"|(?:cannot|can't|can\s+not|unable\s+to|not\s+able\s+to)\s+(?:determine|find|provide|confirm|verify|answer|recall"
    r"|say|identify|locate|give)"
    r"|cannot\s+be\s+determined|(?:could\s*n[o']?t|could\s+not|did\s*n[o']?t|was\s+not\s+able\s+to)\s+find"
    r"|(?:do\s*n[o']?t|don't|do\s+not)\s+have\s+(?:any\s+|enough\s+|specific\s+|reliable\s+|access\s+to\s+)*"
    r"(?:information|data|details|records|knowledge|access)"
    r"|no\s+(?:reliable\s+|specific\s+|available\s+|public\s+)*(?:information|data|record)s?"
    r"|not\s+(?:publicly\s+)?(?:available|documented|known)|is\s+unknown)\b"
    r"|不知道|不确定|不清楚|无法确定|无法回答|无法提供|无法找到|没有相关信息|我不了解|不太确定|无从得知",
    re.IGNORECASE)
_GUESS = re.compile(r"\b(?:it|he|she|they|this|that|the\s+answer)\s+(?:might|may|could)\s+(?:be|have\s+been)\b"
                    r"|\b(?:possibly|perhaps|probably|i\s+think|i\s+believe|best\s+guess|my\s+guess"
                    r"|(?:is|was)\s+likely)\b|可能是|也许是|大概是", re.IGNORECASE)


def _fold(text):
    text = unicodedata.normalize("NFKC", text).translate(_FOLD)
    text = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    return text.casefold()


def tokens(text):
    """Lower-cased, accent-free word tokens with punctuation and articles dropped."""
    text = re.sub(r"['’`]", "", _fold(text))
    text = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", text)
    text = _ARTICLE.sub(" ", text)
    return re.findall(r"\w+", text)


def _contains(haystack, needle):
    n = len(needle)
    return n > 0 and any(haystack[i:i + n] == needle for i in range(len(haystack) - n + 1))


def _to_number(text, scale=None):
    value = float(text.replace(",", ""))
    if scale:
        value *= _SCALE[scale.lower()]
    return value


def numbers(text):
    """Every number in text, in order: digits (1,234 / 3.5 / 2 million) and number words up to ninety-nine."""
    found = [(m.start(), _to_number(m.group(1), m.group(2))) for m in _NUMBER.finditer(text)]
    for m in _WORD_NUMBER.finditer(text):
        if m.group(3):
            value = _SMALL[m.group(3).lower()]
        else:
            value = _TENS[m.group(1).lower()] + (_SMALL[m.group(2).lower()] if m.group(2) else 0)
        found.append((m.start(), float(value)))
    return [value for _, value in sorted(found)]


def _dates(text):
    """(day, month, year) for each date in text, in order; day or month is None when not given."""
    toks = [t for t in tokens(text) if t != "of"]
    found = []
    for m in _ISO_DATE.finditer(text):
        found.append((m.start(), (int(m.group(3)), int(m.group(2)), int(m.group(1)))))
    i = 0
    out = []
    while i < len(toks):
        t = toks[i]
        nxt = toks[i + 1:i + 4]
        if t.isdigit() and len(t) <= 2 and nxt[:1] and nxt[0] in _MONTHS and len(nxt) > 1 and _is_year(nxt[1]):
            out.append((int(t), _MONTHS[nxt[0]], int(nxt[1])))
            i += 3
        elif t in _MONTHS and nxt[:1] and nxt[0].isdigit() and len(nxt[0]) <= 2 and len(nxt) > 1 and _is_year(nxt[1]):
            out.append((int(nxt[0]), _MONTHS[t], int(nxt[1])))
            i += 3
        elif t in _MONTHS and nxt[:1] and _is_year(nxt[0]):
            out.append((None, _MONTHS[t], int(nxt[0])))
            i += 2
        elif _is_year(t):
            out.append((None, None, int(t)))
            i += 1
        else:
            i += 1
    return [d for _, d in found] + out


def _is_year(tok):
    return tok.isdigit() and len(tok) == 4


def target(answer):
    """What a reply must contain, derived from the gold string only."""
    gold = answer["gold"]
    kind = answer["type"]
    if kind == "Number":
        main = _RANGE.split(gold)[0]
        value = numbers(main)[0]
        m = _RANGE.search(gold)
        if m:
            lo, hi = numbers(m.group(1))[0], numbers(m.group(2))[0]
            return {"kind": "number", "low": min(lo, hi, value), "high": max(lo, hi, value)}
        return {"kind": "number", "low": value, "high": value}
    if kind == "Date":
        dates = _dates(gold)
        if len(dates) != 1:
            raise ValueError(f"gold {gold!r} is not one date")
        return {"kind": "date", "date": dates[0]}
    clean = gold.strip().strip(".").strip()
    names = [tokens(clean)]
    if kind == "Person":
        bare = list(names[0])
        while len(bare) > 2 and bare[0] in _TITLES:
            bare.pop(0)
        names.append(bare)
    if kind == "Place" and "," in clean:
        names.append(tokens(clean.split(",")[0]))
    return {"kind": "name", "names": [n for n in names if n]}


def _first_new(values, seen):
    for value in values:
        if value not in seen:
            return value
    return None


def _date_ok(want, got):
    day, month, year = want
    return got[2] == year and (month is None or got[1] == month) and (day is None or got[0] == day)


_ANSWER_LINE = re.compile(r"\banswer\b\W{0,4}[:：]\W*(.+)", re.IGNORECASE)
_LIST_MARKER = re.compile(r"^\s*(?:\d{1,2}[.)]|[-*•])\s+", re.MULTILINE)
_SENTENCE_END = re.compile(r"[.!?。！？](?=\s|$)|\n")
_ABBREVIATIONS = {"st", "dr", "mr", "mrs", "ms", "jr", "sr", "mt", "ft", "no", "vs", "prof", "gen", "col", "capt",
                  "rev", "sgt", "lt", "inc", "co", "ltd", "u.s", "e.g", "i.e", "approx", "ca", "c"}


def _answer_part(content):
    """The text that holds the answer: what follows the last "Answer:" label, else the first sentence."""
    labelled = _ANSWER_LINE.findall(content)
    text = labelled[-1] if labelled else content
    text = text.strip()
    for m in _SENTENCE_END.finditer(text):
        before = text[:m.start()]
        if m.group() == "\n":
            if before.strip():
                return before
            continue
        word = re.search(r"([\w.]+)$", before)
        word = word.group(1).lower() if word else ""
        if m.group() == "." and (len(word.replace(".", "")) <= 1 or word.rstrip(".") in _ABBREVIATIONS):
            continue
        return text[:m.end()]
    return text


def _match(tgt, content, question):
    """(matched, offered, why_not): did the reply give the gold, did it offer any answer of the gold's kind."""
    if tgt["kind"] == "name":
        toks = tokens(_answer_part(content))
        return any(_contains(toks, n) for n in tgt["names"]), True, ""
    labelled = _ANSWER_LINE.findall(content)
    text = _LIST_MARKER.sub(" ", labelled[-1] if labelled else content)
    if tgt["kind"] == "number":
        seen = set(numbers(question))
        if not (1000 <= tgt["low"] and tgt["high"] <= 2100):
            seen |= {n for n in numbers(text) if n.is_integer() and 1000 <= n <= 2100}
        first = _first_new(numbers(text), seen)
        if first is None:
            return False, False, "gave no number"
        if tgt["low"] - 1e-9 <= first <= tgt["high"] + 1e-9:
            return True, True, ""
        return False, True, f"first number given was {first:g}"
    seen = {d[2] for d in _dates(question)}
    dates = [d for d in _dates(text) if d[2] not in seen]
    if not dates:
        return False, False, "gave no date"
    if _date_ok(tgt["date"], dates[0]):
        return True, True, ""
    return False, True, "first date given was " + "-".join(str(p) for p in dates[0][::-1] if p is not None)


def _snippet(text, limit=60):
    one_line = " ".join(text.split())
    return one_line if len(one_line) <= limit else one_line[: limit - 3] + "..."


def grade(item, resp):
    content = resp["content"].strip()
    gold = item["answer"]["gold"]
    if not content:
        return verdict(WRONG, f"empty answer, expected '{gold}'")
    question = next((m["content"] for m in item["messages"] if m["role"] == "user"), "")
    tgt = target(item["answer"])
    matched, offered, why = _match(tgt, content, question)
    if matched:
        return verdict(PASS, f"answered '{gold}'")
    if _ABSTAIN.search(content):
        guessed = offered if tgt["kind"] != "name" else bool(_GUESS.search(content))
        if not guessed:
            return verdict(ABSTAINED, "said it does not know")
    detail = f"answered '{_snippet(_answer_part(content))}', expected '{gold}'"
    return verdict(WRONG, detail + (f" ({why})" if why else ""))
