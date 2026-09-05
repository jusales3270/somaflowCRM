"use client";

import { useEffect, useState } from "react";
import { useTheme } from "@/lib/theme";
import { useHotkeys } from "react-hotkeys-hook";
import { Sun, Moon, MonitorPlay } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  const cycle = () => {
    setTheme(theme === "light" ? "dark" : theme === "dark" ? "system" : "light");
  };

  useHotkeys("mod+shift+l", cycle, { preventDefault: true }, [theme]);

  if (!mounted) {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label="Alternar tema"
        disabled
      >
        <span className="inline-block h-4 w-4" />
      </Button>
    );
  }

  const Icon = theme === "dark" ? Moon : theme === "system" ? MonitorPlay : Sun;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      aria-label={`Tema: ${theme}. Cmd+Shift+L para alternar.`}
    >
      <Icon size={16} aria-hidden />
    </Button>
  );
}

