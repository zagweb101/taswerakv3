"use client";

import { useState, useCallback, useEffect } from "react";

type Locale = "ar" | "en";

const STORAGE_KEY = "taswerak-locale";

/**
 * Lightweight locale switcher. Stores preference in localStorage
 * and updates `document.documentElement.lang` and `dir`.
 *
 * Note: this is NOT full next-intl routing — it's a client-side
 * toggle that switches the active message set. Full SSR i18n routing
 * can be added later via next-intl's middleware.
 */
export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>("ar");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
    if (stored && stored !== locale) {
      setLocaleState(stored);
      applyLocale(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyLocale(next);
  }, []);

  const toggle = useCallback(() => {
    setLocale(locale === "ar" ? "en" : "ar");
  }, [locale, setLocale]);

  return { locale, setLocale, toggle };
}

function applyLocale(locale: Locale) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
}
