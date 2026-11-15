"""Parse and format durations such as "1h30m"."""

UNITS = (("d", 86400), ("h", 3600), ("m", 60), ("s", 1))


def parse_duration(text):
    """Parse a duration such as "1h30m" and return the total number of seconds.

    The text is one or more parts. Each part is a whole number followed by a
    unit: d (days), h (hours), m (minutes) or s (seconds). Units are lowercase
    and there are no spaces anywhere in the text. Each unit appears at most
    once, and units appear in the order d, h, m, s.

    Raises ValueError for an empty string, an unknown unit, a unit with no
    number before it, a number with no unit after it, and a repeated or
    out-of-order unit.

    >>> parse_duration("90s")
    90
    >>> parse_duration("1h30m")
    5400
    >>> parse_duration("2d")
    172800
    >>> parse_duration("1d2h3m4s")
    93784
    >>> parse_duration("0s")
    0
    """
    if not text:
        raise ValueError("empty duration")
    total = 0
    number = ""
    allowed = [unit for unit, _ in UNITS]
    sizes = dict(UNITS)
    for ch in text:
        if ch in "0123456789":
            number += ch
            continue
        if ch not in sizes:
            raise ValueError(f"unknown unit {ch!r}")
        if not number:
            raise ValueError(f"unit {ch!r} has no number")
        if ch not in allowed:
            raise ValueError(f"unit {ch!r} is repeated or out of order")
        allowed = allowed[allowed.index(ch) + 1:]
        total += int(number) * sizes[ch]
        number = ""
    if number:
        raise ValueError(f"number {number!r} has no unit")
    return total


def format_duration(seconds):
    """Format a whole number of seconds the way parse_duration reads it.

    Units with a zero count are left out, except that 0 formats as "0s".

    >>> format_duration(5400)
    '1h30m'
    >>> format_duration(0)
    '0s'
    """
    if seconds < 0:
        raise ValueError("seconds must not be negative")
    parts = []
    for unit, size in UNITS:
        count, seconds = divmod(seconds, size)
        if count:
            parts.append(f"{count}{unit}")
    return "".join(parts) or "0s"
