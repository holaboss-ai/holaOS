import { AlertTriangle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CreditsPillProps {
  balance: number | null;
  isLoading?: boolean;
  isLowBalance?: boolean;
  onClick: () => void;
}

export function CreditsPill({
  balance,
  isLoading = false,
  isLowBalance = false,
  onClick,
}: CreditsPillProps) {
  if (isLoading) {
    return (
      <Button
        type="button"
        size="sm"
        variant="bordered"
        role="status"
        aria-busy="true"
        aria-label="Loading credits balance"
      >
        <span className="size-3.5 animate-pulse rounded-full bg-muted" />
        <span className="h-3 w-10 animate-pulse rounded bg-muted" />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="bordered"
      onClick={onClick}
      aria-label={
        isLowBalance
          ? "Credits balance low — open billing"
          : "Open credits and billing details"
      }
    >
      {isLowBalance ? <AlertTriangle className="text-warning" /> : <Sparkles />}
      <span className="tabular-nums">
        {(balance ?? 0).toLocaleString()}
      </span>
    </Button>
  );
}
