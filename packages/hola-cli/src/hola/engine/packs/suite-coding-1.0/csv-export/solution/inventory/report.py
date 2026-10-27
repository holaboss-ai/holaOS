import csv
import io


def format_price(cents):
    return f"{cents // 100}.{cents % 100:02d}"


def sort_items(items):
    return sorted(items, key=lambda item: item.sku)


def render_table(items):
    header = f"{'SKU':<8} {'NAME':<20} {'QTY':>5} {'PRICE':>9}"
    lines = [header, "-" * len(header)]
    for item in sort_items(items):
        lines.append(f"{item.sku:<8} {item.name:<20} {item.qty:>5} {format_price(item.price_cents):>9}")
    return "\n".join(lines)


def render_csv(items):
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["sku", "name", "qty", "unit_price"])
    for item in sort_items(items):
        writer.writerow([item.sku, item.name, item.qty, format_price(item.price_cents)])
    return out.getvalue()
