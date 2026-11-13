"""IFEval (google/IFEval), strict prompt level: every instruction of the prompt must be followed.

A stdlib port of the upstream rule checkers (google-research instruction_following_eval/instructions.py,
Apache-2.0) for the instructions that need no sentence splitter or language detector. Each checker keeps the
upstream logic line for line; tests/suite11/fixtures/ifeval.json pins agreement with the official code.
"""

import collections
import json
import re

from .common import PASS, WRONG, verdict


def existence(value, kw):
    return all(re.search(keyword, value, flags=re.IGNORECASE) for keyword in sorted(kw["keywords"]))


def frequency(value, kw):
    occurrences = len(re.findall(kw["keyword"].strip(), value, flags=re.IGNORECASE))
    if kw["relation"] == "less than":
        return occurrences < kw["frequency"]
    return occurrences >= kw["frequency"]


def forbidden_words(value, kw):
    for word in sorted(set(kw["forbidden_words"])):
        if re.search(r"\b" + word + r"\b", value, flags=re.IGNORECASE):
            return False
    return True


def letter_frequency(value, kw):
    count = collections.Counter(value.lower())[kw["letter"].strip().lower()]
    if kw["let_relation"] == "less than":
        return count < kw["let_frequency"]
    return count >= kw["let_frequency"]


def number_paragraphs(value, kw):
    paragraphs = re.split(r"\s?\*\*\*\s?", value)
    num_paragraphs = len(paragraphs)
    for index, paragraph in enumerate(paragraphs):
        if not paragraph.strip():
            if index == 0 or index == len(paragraphs) - 1:
                num_paragraphs -= 1
            else:
                return False
    return num_paragraphs == kw["num_paragraphs"]


def number_words(value, kw):
    num_words = len(re.findall(r"\w+", value))
    if kw["relation"] == "less than":
        return num_words < kw["num_words"]
    return num_words >= kw["num_words"]


def nth_paragraph_first_word(value, kw):
    paragraphs = re.split(r"\n\n", value)
    num_paragraphs = len(paragraphs) - sum(1 for p in paragraphs if not p.strip())
    if kw["nth_paragraph"] > num_paragraphs:
        return False
    paragraph = paragraphs[kw["nth_paragraph"] - 1].strip()
    if not paragraph:
        return False
    word = paragraph.split()[0].strip().lstrip("'").lstrip('"')
    first_word = ""
    for letter in word:
        if letter in {".", ",", "?", "!", "'", '"'}:
            break
        first_word += letter.lower()
    return num_paragraphs == kw["num_paragraphs"] and first_word == kw["first_word"].lower()


def number_placeholders(value, kw):
    return len(re.findall(r"\[.*?\]", value)) >= kw["num_placeholders"]


def postscript(value, kw):
    marker = kw["postscript_marker"].strip()
    value = value.lower()
    if marker == "P.P.S":
        pattern = r"\s*p\.\s?p\.\s?s.*$"
    elif marker == "P.S.":
        pattern = r"\s*p\.\s?s\..*$"
    else:
        pattern = r"\s*" + marker.lower() + r".*$"
    return bool(re.findall(pattern, value, flags=re.MULTILINE))


def number_bullet_lists(value, kw):
    stars = re.findall(r"^\s*\*[^\*].*$", value, flags=re.MULTILINE)
    dashes = re.findall(r"^\s*-.*$", value, flags=re.MULTILINE)
    return len(stars) + len(dashes) == kw["num_bullets"]


def constrained_response(value, kw):
    value = value.strip()
    return any(option in value for option in ("My answer is yes.", "My answer is no.", "My answer is maybe."))


def number_highlighted_sections(value, kw):
    count = sum(1 for h in re.findall(r"\*[^\n\*]*\*", value) if h.strip("*").strip())
    count += sum(1 for h in re.findall(r"\*\*[^\n\*]*\*\*", value) if h.removeprefix("**").removesuffix("**").strip())
    return count >= kw["num_highlights"]


def multiple_sections(value, kw):
    pattern = r"\s?" + kw["section_spliter"].strip() + r"\s?\d+\s?"
    return len(re.split(pattern, value)) - 1 >= kw["num_sections"]


def json_format(value, kw):
    value = (value.strip().removeprefix("```json").removeprefix("```Json").removeprefix("```JSON")
             .removeprefix("```").removesuffix("```").strip())
    try:
        json.loads(value)
    except ValueError:
        return False
    return True


def title(value, kw):
    return any(t.lstrip("<").rstrip(">").strip() for t in re.findall(r"<<[^\n]+>>", value))


def two_responses(value, kw):
    valid = []
    responses = value.split("******")
    for index, response in enumerate(responses):
        if not response.strip():
            if index != 0 and index != len(responses) - 1:
                return False
        else:
            valid.append(response)
    return len(valid) == 2 and valid[0].strip() != valid[1].strip()


def repeat_prompt(value, kw):
    return value.strip().lower().startswith(kw["prompt_to_repeat"].strip().lower())


def end_checker(value, kw):
    return value.strip().strip('"').lower().endswith(kw["end_phrase"].strip().lower())


def no_comma(value, kw):
    return not re.search(r"\,", value)


def quotation(value, kw):
    value = value.strip()
    return len(value) > 1 and value[0] == '"' and value[-1] == '"'


CHECKERS = {
    "keywords:existence": existence,
    "keywords:frequency": frequency,
    "keywords:forbidden_words": forbidden_words,
    "keywords:letter_frequency": letter_frequency,
    "length_constraints:number_paragraphs": number_paragraphs,
    "length_constraints:number_words": number_words,
    "length_constraints:nth_paragraph_first_word": nth_paragraph_first_word,
    "detectable_content:number_placeholders": number_placeholders,
    "detectable_content:postscript": postscript,
    "detectable_format:number_bullet_lists": number_bullet_lists,
    "detectable_format:constrained_response": constrained_response,
    "detectable_format:number_highlighted_sections": number_highlighted_sections,
    "detectable_format:multiple_sections": multiple_sections,
    "detectable_format:json_format": json_format,
    "detectable_format:title": title,
    "combination:two_responses": two_responses,
    "combination:repeat_prompt": repeat_prompt,
    "startend:end_checker": end_checker,
    "punctuation:no_comma": no_comma,
    "startend:quotation": quotation,
}


def followed(instruction_ids, kwargs, value):
    """Per-instruction results under upstream strict mode (a blank response follows nothing)."""
    results = []
    for instruction_id, kw in zip(instruction_ids, kwargs):
        if instruction_id not in CHECKERS:
            raise ValueError(f"ifeval has no stdlib checker for {instruction_id!r}")
        results.append(bool(value.strip() and CHECKERS[instruction_id](value, kw)))
    return results


def grade(item, resp):
    answer = item["answer"]
    ids = answer["instruction_id_list"]
    results = followed(ids, answer["kwargs"], resp["content"])
    missed = [i for i, ok in zip(ids, results) if not ok]
    if not missed:
        return verdict(PASS, f"followed all {len(ids)} instruction(s)")
    return verdict(WRONG, f"did not follow {', '.join(missed)}")
