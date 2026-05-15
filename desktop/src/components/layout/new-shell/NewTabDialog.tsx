import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtom } from "jotai";
import {
  CornerDownLeft,
  FileText,
  Globe,
  LayoutDashboard,
} from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { newTabOpenAtom } from "./state/ui";

type RecentTabType = "browser" | "doc" | "dashboard";

const RECENTLY_CLOSED: Array<{
  id: string;
  type: RecentTabType;
  title: string;
  sub: string;
  when: string;
}> = [
  {
    id: "r1",
    type: "browser",
    title: "Joshua Li · LinkedIn",
    sub: "linkedin.com/in/joshli",
    when: "2h",
  },
  {
    id: "r2",
    type: "dashboard",
    title: "Engagement",
    sub: "Dashboard",
    when: "1d",
  },
  {
    id: "r3",
    type: "doc",
    title: "launch brief",
    sub: "Doc",
    when: "3d",
  },
];

function iconForType(type: RecentTabType) {
  if (type === "browser") return <Globe />;
  if (type === "dashboard") return <LayoutDashboard />;
  return <FileText />;
}

export function NewTabDialog() {
  const [open, setOpen] = useAtom(newTabOpenAtom);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          style={{
            animationDuration: "180ms",
            animationTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        />
        <DialogPrimitive.Popup
          className="fixed top-[18%] left-1/2 z-[100] w-[560px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl outline-none backdrop-blur-2xl data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          style={{
            animationDuration: "220ms",
            animationTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <Command className="bg-transparent">
            <CommandInput placeholder="Search or enter URL..." />
            <CommandList className="max-h-[420px] px-1.5 pt-1 pb-2">
              <CommandEmpty>No matches.</CommandEmpty>
              <CommandGroup heading="Recently closed">
                {RECENTLY_CLOSED.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={`${item.title} ${item.sub}`}
                    className="group/cmd-item gap-2.5 py-1.5"
                  >
                    <span
                      aria-hidden
                      className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-foreground/[0.06] text-foreground/55 ring-1 ring-inset ring-foreground/5 [&_svg]:size-3"
                    >
                      {iconForType(item.type)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-sm">{item.title}</span>
                      <span className="truncate text-xs text-foreground/40">
                        {item.sub}
                      </span>
                    </span>
                    <span className="text-xs tabular-nums text-foreground/35 transition-opacity duration-200 ease-out group-data-[selected=true]/cmd-item:opacity-0">
                      {item.when}
                    </span>
                    <CornerDownLeft className="-ml-4 size-3 text-foreground/40 opacity-0 transition-opacity duration-200 ease-out group-data-[selected=true]/cmd-item:opacity-100" />
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Create new">
                {(
                  [
                    { id: "new-doc", icon: FileText, label: "New Doc" },
                    {
                      id: "new-dash",
                      icon: LayoutDashboard,
                      label: "New Dashboard",
                    },
                  ] as const
                ).map(({ id, icon: Icon, label }) => (
                  <CommandItem
                    key={id}
                    value={label}
                    className="group/cmd-item gap-2.5 py-1.5"
                  >
                    <span
                      aria-hidden
                      className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-foreground/[0.06] text-foreground/55 ring-1 ring-inset ring-foreground/5"
                    >
                      <Icon className="size-3" />
                    </span>
                    <span className="flex-1 truncate text-sm">{label}</span>
                    <CornerDownLeft className="size-3 text-foreground/40 opacity-0 transition-opacity duration-200 ease-out group-data-[selected=true]/cmd-item:opacity-100" />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            <div className="flex items-center justify-between border-t border-border bg-foreground/[0.02] px-3 py-2 text-xs text-foreground/40">
              <span className="flex items-center gap-1.5">
                <span className="inline-flex gap-0.5">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                </span>
                navigate
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                open
                <span className="mx-1 text-foreground/20">·</span>
                <Kbd>esc</Kbd>
                close
              </span>
            </div>
          </Command>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
