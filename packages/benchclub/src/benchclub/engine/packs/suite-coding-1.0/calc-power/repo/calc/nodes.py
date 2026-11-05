from dataclasses import dataclass


@dataclass(frozen=True)
class Num:
    value: float


@dataclass(frozen=True)
class Unary:
    op: str
    operand: object


@dataclass(frozen=True)
class Binary:
    op: str
    left: object
    right: object
