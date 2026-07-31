"use client";

import { useLayoutEffect } from "react";
import { useSiteSettings } from "@/lib/site-settings-store";

export default function SiteSettingsHydrator({ settings }: { settings: unknown }) {
  useLayoutEffect(() => {
    if (settings) useSiteSettings.getState().hydrateSettings(settings);
  }, [settings]);
  return null;
}
