# Memory Management

When and how to update `.interface-design/system.md`.

## When to Add Patterns

Add to system.md when:
- Component used 2+ times
- Pattern is reusable across the project
- Has specific measurements worth remembering

## Pattern Format

```markdown
### Button Primary
- Height: 36px
- Padding: 12px 16px
- Radius: 6px
- Font: 14px, 500 weight
```

## Don't Document

- One-off components
- Temporary experiments
- Variations better handled with props

## Pattern Reuse

Before creating a component, check system.md:
- Pattern exists? Use it.
- Need variation? Extend, don't create new.

Memory compounds: each pattern saved makes future work faster and more consistent.

---

# Validation Checks

If system.md defines specific values, check consistency:

**Spacing** — All values multiples of the defined base?

**Depth** — Using the declared strategy throughout? (borders-only means no shadows)

**Colors** — Using defined palette, not random hex codes?

**Patterns** — Reusing documented patterns instead of creating new?
