"""Split a list into pages."""


def paginate(items, page, per_page):
    """Return the items on one page.

    Pages are numbered from 1. A page past the end is empty.
    Raises ValueError if page or per_page is less than 1.
    """
    if page < 1 or per_page < 1:
        raise ValueError("page and per_page must be at least 1")
    start = page * per_page
    return items[start:start + per_page]


def page_count(total, per_page):
    """Return how many pages `total` items need. No items need no pages."""
    if per_page < 1:
        raise ValueError("per_page must be at least 1")
    return (total + per_page - 1) // per_page
