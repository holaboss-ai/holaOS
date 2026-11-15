"""Turn an expression string into tokens."""

from dataclasses import dataclass


class CalcError(Exception):
    """Raised for any expression the calculator can't evaluate."""


@dataclass(frozen=True)
class Token:
    kind: str  # "num", "op", "lparen", "rparen" or "end"
    text: str
    pos: int


OPERATORS = "+-*/"


def tokenize(text):
    tokens = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch.isspace():
            i += 1
        elif ch.isdigit() or ch == ".":
            start = i
            while i < len(text) and (text[i].isdigit() or text[i] == "."):
                i += 1
            tokens.append(Token("num", text[start:i], start))
        elif text.startswith("**", i):
            tokens.append(Token("op", "**", i))
            i += 2
        elif ch in OPERATORS:
            tokens.append(Token("op", ch, i))
            i += 1
        elif ch == "(":
            tokens.append(Token("lparen", ch, i))
            i += 1
        elif ch == ")":
            tokens.append(Token("rparen", ch, i))
            i += 1
        else:
            raise CalcError(f"unexpected character {ch!r} at {i}")
    tokens.append(Token("end", "", len(text)))
    return tokens
