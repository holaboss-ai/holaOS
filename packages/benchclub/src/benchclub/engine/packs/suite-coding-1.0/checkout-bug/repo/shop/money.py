def percent_of(cents, pct):
    """Return pct percent of an amount in cents, in whole cents."""
    return cents * pct // 100


def format_cents(cents):
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"
