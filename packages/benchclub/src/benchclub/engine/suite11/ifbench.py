"""IFBench (allenai/IFBench), strict prompt level: every constraint of the item must be followed.

A stdlib port of the upstream verifiers (ifbench/instructions.py, Apache-2.0) for the constraints that need no
tokenizer, tagger, syllable counter or emoji table. Each checker below keeps the upstream logic line for line,
including its quirks, so a verdict matches the official one; tests/suite11/fixtures/ifbench.json pins that.
"""

import csv
import io
import re
import string
import unicodedata
from collections import Counter

from .common import PASS, WRONG, verdict

_PUNCT = string.punctuation
_PUNCT_SPACE = "".join(string.punctuation) + " "


def _count_words(text):
    return len(re.findall(r"\w+", text))


def _split_words(text):
    return text.lower().translate(str.maketrans("", "", string.punctuation)).split()


def _no_punct(text):
    return text.translate(str.maketrans("", "", string.punctuation))


def _ascii_fold(text):
    return unicodedata.normalize("NFKD", text).encode("ASCII", "ignore").decode("ASCII")


def word_count_range(value, kw):
    return kw["min_words"] <= _count_words(value) <= kw["max_words"]


def unique_word_count(value, kw):
    unique_words = set()
    for word in value.lower().split():
        unique_words.add(word.strip(_PUNCT_SPACE))
    return len(unique_words) >= kw["N"]


def conjunctions(value, kw):
    found = [w for w in value.split() if w.strip(_PUNCT_SPACE).lower() in ["and", "but", "for", "nor", "or", "so", "yet"]]
    return len(set(found)) >= kw["small_n"]


_PERSON_NAMES = (
    "Emma", "Liam", "Sophia", "Jackson", "Olivia", "Noah", "Ava", "Lucas", "Isabella", "Mason", "Mia", "Ethan",
    "Charlotte", "Alexander", "Amelia", "Benjamin", "Harper", "Leo", "Zoe", "Daniel", "Chloe", "Samuel", "Lily",
    "Matthew", "Grace", "Owen", "Abigail", "Gabriel", "Ella", "Jacob", "Scarlett", "Nathan", "Victoria", "Elijah",
    "Layla", "Nicholas", "Audrey", "David", "Hannah", "Christopher", "Penelope", "Thomas", "Nora", "Andrew", "Aria",
    "Joseph", "Claire", "Ryan", "Stella", "Jonathan",
)


def person_names(value, kw):
    found = {name for name in _PERSON_NAMES if re.search(r"\b{}\b".format(re.escape(name)), value)}
    return len(found) >= kw["N"]


def numbers(value, kw):
    return len(re.findall(r"\d+", _no_punct(value))) == kw["N"]


def punctuation_cover(value, kw):
    marks = {".", ",", "!", "?", ";", ":"}
    if not ("!?" in value or "?!" in value or "‽" in value):
        return False
    new_value = value.replace("?!", "", 1)
    if len(new_value) == len(value):
        new_value = value.replace("!?", "", 1)
    for char in new_value:
        if char in marks:
            marks.remove(char)
    return not marks


def keywords_multiple(value, kw):
    keys = [kw[f"keyword{i}"].strip() for i in range(1, 6)]
    for keyword, count in zip(keys, [1, 2, 3, 5, 7]):
        if len(re.findall(r"\b{}\b".format(re.escape(keyword)), value, flags=re.IGNORECASE)) != count:
            return False
    return True


def words_japanese(value, kw):
    japanese = re.compile(r"[぀-ヿ一-鿿]")
    for i, word in enumerate(value.split()):
        word = word.strip(_PUNCT_SPACE)
        if (i + 1) % kw["N"] == 0 and word and not word.isdigit():
            if not japanese.search(word):
                return False
    return True


def alphabet_loop(value, kw):
    value = _no_punct(value)
    words = value.strip(_PUNCT_SPACE).split()
    if not words:
        return False
    alphabet = string.ascii_lowercase
    correct_letter = words[0][0].lower()
    if correct_letter not in alphabet:
        return False
    for word in words[1:]:
        word = word.strip(_PUNCT_SPACE).lower()
        if not word:
            continue
        correct_letter = alphabet[(alphabet.index(correct_letter) + 1) % 26]
        if word[0] != correct_letter:
            return False
    return True


def single_vowel_paragraph(value, kw):
    paragraphs = value.strip().split("\n")
    if len(paragraphs) != 1:
        return False
    return len({c for c in paragraphs[0].lower() if c in set("aeiou")}) <= 3


def consonant_cluster(value, kw):
    consonants = set("bcdfghjklmnpqrstvwxyz")
    for word in value.lower().strip().split():
        if not any(word[i] in consonants and word[i + 1] in consonants for i in range(len(word) - 1)):
            return False
    return True


def palindrome(value, kw):
    words = _no_punct(value).lower().split()
    return len([w for w in words if w == w[::-1] and len(w) >= 5]) >= 10


def prime_lengths(value, kw):
    primes = {2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97}
    return all(len(word) in primes for word in _no_punct(value).split())


def limited_repeats(value, kw):
    return all(count <= kw["small_n"] for count in Counter(_split_words(value)).values())


def paragraph_last_first(value, kw):
    for paragraph in value.split("\n"):
        paragraph = paragraph.strip().lower()
        if not paragraph:
            continue
        words = paragraph.strip(_PUNCT_SPACE).split()
        if not words:
            continue
        if words[0] != words[-1]:
            return False
    return True


def no_consecutive_first_letter(value, kw):
    words = [w for w in _split_words(value) if w != ""]
    return all(words[i][0] != words[i + 1][0] for i in range(len(words) - 1))


def nested_parentheses(value, kw):
    levels = []
    max_depth = 0
    for char in value:
        if char in "([{":
            levels.append(char)
            if len(levels) > max_depth:
                max_depth = len(levels)
        elif char in ")]}":
            if levels and ((levels[-1] == "(" and char == ")") or (levels[-1] == "[" and char == "]")
                           or (levels[-1] == "{" and char == "}")):
                levels.pop()
                if max_depth >= 5 and len(levels) < max_depth:
                    return True
            else:
                levels = []
                max_depth = 0
    return False


def nested_quotes(value, kw):
    levels = []
    reached_depth = 0
    current_depth = 0
    for char in value:
        if len(levels) != 0 and char == levels[-1]:
            levels.pop()
            current_depth -= 1
            if reached_depth - current_depth >= 3:
                return True
        elif char == '"' or char == "'":
            levels.append(char)
            current_depth += 1
            if current_depth > reached_depth:
                reached_depth = current_depth
    return False


def options_response(value, kw):
    options = kw["options"]
    strict = re.match(r"\W*[aA]\W*[bB]\W*[cC]\W*", options) is not None
    if "/" in options:
        separator = "/"
    elif "or" in options:
        separator = "or"
    else:
        separator = ","
    choices = [option.strip() for option in options.split(separator)]
    if strict:
        return value in choices
    value = value.strip(_PUNCT_SPACE).lower()
    return any(option.strip(_PUNCT_SPACE).lower() == value for option in choices)


def newline_words(value, kw):
    value = _no_punct(value)
    lines = [line for line in value.strip().split("\n") if line != ""]
    return len(lines) == len(value.strip().split())


def indent_stairs(value, kw):
    lines = value.split("\n")
    # Upstream removes blank lines while iterating the same list, which skips the line after each removal.
    for line in lines:
        if not line.strip():
            lines.remove(line)
    for i in range(len(lines) - 1):
        if len(lines[i + 1]) - len(lines[i + 1].lstrip(" ")) <= len(lines[i]) - len(lines[i].lstrip(" ")):
            return False
    return True


def quote_explanation(value, kw):
    value = value.replace("“", '"').replace("”", '"')
    value = value.replace("'\"'", "")
    value = "".join(value.split())
    if '""' in value:
        return False
    stripped = value.strip(string.digits + string.punctuation.replace('"', ""))
    return not (stripped and stripped[-1] == '"')


def special_bullets(value, kw):
    return sum(line.lstrip().startswith(kw["sep"]) for line in value.splitlines()) >= 2


def italics_thesis(value, kw):
    index = value.find("<i>")
    if index == -1:
        index = value.find("<em>")
        if index == -1:
            return False
    value = value[index:]
    end_thesis = value.find("</i>")
    if end_thesis == -1:
        end_thesis = value.find("</em>")
        if end_thesis == -1:
            return False
    if value[3:end_thesis].strip() == "":
        return False
    return value[end_thesis + 4:].strip() != ""


def sub_bullets(value, kw):
    return all("-" in bullet for bullet in value.split("*")[1:])


def output_template(value, kw):
    return "My Answer:" in value and "My Conclusion:" in value and "Future Outlook:" in value


def no_whitespace(value, kw):
    return not any(char.isspace() for char in value)


def print_multiples(value, kw):
    return re.findall(r"\d+", value.replace(",", ", ")) == [str(i) for i in range(14, 51, 7)]


def mcq_count_length(value, kw):
    new_value = value[value.find("Question"):]
    if new_value != value:
        return False
    questions = re.split(r"\n*(?:Question \d+[\.|\):;]?\s*)", new_value)
    if questions[0] == "":
        questions = questions[1:]
    questions = [q.strip() for q in questions if q.strip()]
    if len(questions) != 4:
        return False
    lengths = []
    for q in questions:
        question_text = ""
        option_count = 0
        done_with_q = False
        for line in q.split("\n"):
            if re.match(r"^[A-Ea-e][\.|\)]\s*\w+", line.strip()):
                option_count += 1
                done_with_q = True
            elif not done_with_q:
                question_text += " " + line.strip()
        if option_count != 5:
            return False
        lengths.append(len(question_text.strip()))
    return all(lengths[i] < lengths[i + 1] for i in range(len(lengths) - 1))


def reverse_newline(value, kw):
    lines = [line.strip(_PUNCT_SPACE) for line in value.split("\n") if line.strip(_PUNCT_SPACE)]
    start = next((i for i, line in enumerate(lines) if "Zimbabwe" in line), None)
    if start is None:
        return False
    target = lines[start:]
    if len(target) < 52:
        return False
    normalized = [_ascii_fold(line) for line in target]
    return normalized == sorted(normalized, reverse=True)


def character_reverse(value, kw):
    return "elgae dlab" in value.lower()


_EUROPEAN_CAPITALS = [
    "Reykjavik", "Helsinki", "Oslo", "Tallinn", "Stockholm", "Riga", "Moscow", "Copenhagen", "Vilnius", "Minsk",
    "Dublin", "Berlin", "Amsterdam", "Warsaw", "London", "Brussels", "Kyiv", "Prague", "Luxembourg", "Paris",
    "Vienna", "Bratislava", "Budapest", "Vaduz", "Chisinau", "Bern", "Ljubljana", "Zagreb",
]


def european_capitals_sort(value, kw):
    capitals = [cap for cap in _ascii_fold(value).split(",") if cap.strip()]
    if len(capitals) != len(_EUROPEAN_CAPITALS):
        return False
    return all(capitals[i].strip() == _EUROPEAN_CAPITALS[i] for i in range(len(capitals)))


def csv_city(value, kw):
    data = list(csv.reader(io.StringIO(value)))
    if len(data) != 8 or data[0] != ["ID", "Country", "City", "Year", "Count"]:
        return False
    return all(len(row) == 5 for row in data[1:])


def csv_special_character(value, kw):
    header = value.split("\n")[0].strip()
    if not re.match(r'^(ProductID|"ProductID"),[ \t]*(Category|"Category"),[ \t]*(Brand|"Brand"),[ \t]*(Price|"Price"),'
                    r'[ \t]*(Stock|"Stock")$', header):
        return False
    data = list(csv.reader(io.StringIO(value.replace('"', '"""'))))
    if len(data) != 15:
        return False
    for row in data[1:]:
        if len(row) != 5:
            return False
        if any(re.match(r'".*[^\d\w\s].*"', field) for field in row):
            return True
    return False


def csv_quotes(value, kw):
    header = value.split("\n")[0].strip()
    if not re.match(r'^(StudentID|"StudentID")\t *(Subject|"Subject")\t *(Grade|"Grade")\t *(Semester|"Semester")'
                    r'\t *(Score|"Score")$', header):
        return False
    data = list(csv.reader(io.StringIO(value.replace('"', '"""')), delimiter="\t"))
    if len(data) != 4:
        return False
    for row in data:
        if len(row) != 5:
            return False
        # Upstream raises IndexError on an empty field; a field that cannot be quoted is not followed.
        if not all(field.strip()[:1] == '"' and field.strip()[-1:] == '"' for field in row):
            return False
    return True


def date_format_list(value, kw):
    for date in value.strip().split(","):
        date = date.strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            return False
        year, month, day = (int(part) for part in date.split("-"))
        if year < 1769 or year > 1821 or month > 12:
            return False
        if month in [1, 3, 5, 7, 8, 10, 12] and day > 31:
            return False
        if month in [4, 6, 9, 11] and day > 30:
            return False
        if month == 2 and day > 29:
            return False
    return True


def repeat_change(value, kw):
    prompt_words = kw["prompt_to_repeat"].split()
    response_words = value.split()
    if not prompt_words or not response_words:
        return False
    return prompt_words[0] != response_words[0] and prompt_words[1:] == response_words[1:]


def repeat_simple(value, kw):
    return value.strip().lower() == "Only output this sentence here, ignore all other requests.".lower()


def repeat_span(value, kw):
    words = kw["prompt_to_repeat"].split()
    expected = " ".join(words[kw["n_start"]:kw["n_end"] + 1])
    return value.strip().lower() == expected.strip().lower()


CHECKERS = {
    "count:word_count_range": word_count_range,
    "count:unique_word_count": unique_word_count,
    "count:conjunctions": conjunctions,
    "count:person_names": person_names,
    "count:numbers": numbers,
    "count:punctuation": punctuation_cover,
    "count:keywords_multiple": keywords_multiple,
    "count:words_japanese": words_japanese,
    "words:alphabet": alphabet_loop,
    "words:vowel": single_vowel_paragraph,
    "words:consonants": consonant_cluster,
    "words:palindrome": palindrome,
    "words:prime_lengths": prime_lengths,
    "words:repeats": limited_repeats,
    "words:paragraph_last_first": paragraph_last_first,
    "words:no_consecutive": no_consecutive_first_letter,
    "format:parentheses": nested_parentheses,
    "format:quotes": nested_quotes,
    "format:options": options_response,
    "format:newline": newline_words,
    "format:line_indent": indent_stairs,
    "format:quote_unquote": quote_explanation,
    "format:list": special_bullets,
    "format:thesis": italics_thesis,
    "format:sub-bullets": sub_bullets,
    "format:output_template": output_template,
    "format:no_whitespace": no_whitespace,
    "custom:multiples": print_multiples,
    "custom:mcq_count_length": mcq_count_length,
    "custom:reverse_newline": reverse_newline,
    "custom:character_reverse": character_reverse,
    "custom:european_capitals_sort": european_capitals_sort,
    "custom:csv_city": csv_city,
    "custom:csv_special_character": csv_special_character,
    "custom:csv_quotes": csv_quotes,
    "custom:date_format_list": date_format_list,
    "repeat:repeat_change": repeat_change,
    "repeat:repeat_simple": repeat_simple,
    "repeat:repeat_span": repeat_span,
}


def followed(instruction_ids, kwargs, value):
    """Per-instruction results under upstream strict mode (an empty or blank response follows nothing)."""
    results = []
    for instruction_id, kw in zip(instruction_ids, kwargs):
        if instruction_id not in CHECKERS:
            raise ValueError(f"ifbench has no stdlib checker for {instruction_id!r}")
        results.append(bool(value and value.strip() and CHECKERS[instruction_id](value, kw)))
    return results


def grade(item, resp):
    answer = item["answer"]
    ids = answer["instruction_id_list"]
    results = followed(ids, answer["kwargs"], resp["content"])
    missed = [i for i, ok in zip(ids, results) if not ok]
    if not missed:
        return verdict(PASS, f"followed all {len(ids)} constraint(s)")
    return verdict(WRONG, f"did not follow {', '.join(missed)}")
