import { BookOpen, Home, Settings, User2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function OnboardingUserButton() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon-lg" />}>
        <User2 />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() =>
              void window.electronAPI.ui.openSettingsPane("account")
            }
          >
            <User2 />
            Account
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              void window.electronAPI.ui.openSettingsPane("settings")
            }
          >
            <Settings />
            Settings
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() =>
              void window.electronAPI.ui.openExternalUrl(
                "https://www.holaboss.ai",
              )
            }
          >
            <Home />
            Homepage
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              void window.electronAPI.ui.openExternalUrl(
                "https://www.holaboss.ai/docs",
              )
            }
          >
            <BookOpen />
            Docs
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
