import { create } from "zustand";

interface SiteSettingsState {
  /** 动态内容折叠字数阈值，0 表示不折叠 */
  postCollapseLength: number;
  /** 夜间模式自动调度开关 */
  darkModeEnabled: boolean;
  /** 夜间模式开始时间 HH:MM */
  darkModeStartTime: string;
  /** 夜间模式结束时间 HH:MM */
  darkModeEndTime: string;
  /** 网站名称 */
  siteName: string;
  /** 网站 favicon URL */
  faviconUrl: string;
  /** 网站域名 */
  domain: string;
  /** 侧边栏社交链接 JSON */
  socialLinks: string;
  /** 备案号 */
  beian: string;
  /** 备案号点击跳转链接 */
  beianUrl: string;
  /** 页面底部版权 HTML */
  footerHtml: string;
  /** 桌面端背景装饰图 URL，为空时不显示桌面装饰 */
  decorationImage: string;
  /** 网站背景图轮播列表（URL 数组），每次访问随机展示一张 */
  backgroundImages: string[];
  /** 广告是否在归档页显示 */
  adOnArchives: boolean;
  /** 默认文章封面（博主个人资料背景图），文章未设置封面时使用 */
  defaultCover: string;
  /** 进入网站是否自动播放歌单音乐 */
  musicAutoplay: boolean;
  loaded: boolean;
  hydrateSettings: (data: unknown) => void;
  fetchSettings: () => Promise<void>;
}

const DEFAULT_SITE_NAME = "朋友圈博客";

/** 从 localStorage 读取缓存的 siteName/faviconUrl，避免页面初次渲染时闪烁 */
function loadCachedDisplay(): { siteName: string; faviconUrl: string } {
  if (typeof window === "undefined") {
    return { siteName: DEFAULT_SITE_NAME, faviconUrl: "" };
  }
  try {
    const cached = localStorage.getItem("site_settings_display_cache");
    if (cached) {
      const parsed = JSON.parse(cached);
      return {
        siteName: parsed.siteName || DEFAULT_SITE_NAME,
        faviconUrl: parsed.faviconUrl || "",
      };
    }
  } catch {
    // ignore
  }
  return { siteName: DEFAULT_SITE_NAME, faviconUrl: "" };
}

/** 将 siteName/faviconUrl 缓存到 localStorage，供下次页面加载时使用 */
function cacheDisplay(siteName: string, faviconUrl: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      "site_settings_display_cache",
      JSON.stringify({ siteName, faviconUrl })
    );
  } catch {
    // ignore
  }
}

const cachedDisplay = loadCachedDisplay();
let settingsRequest: Promise<void> | null = null;

function normalizeSettings(value: unknown) {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  let bgImages: string[] = [];
  if (Array.isArray(data.backgroundImages)) {
    bgImages = data.backgroundImages.filter((url): url is string => typeof url === "string");
  } else if (typeof data.backgroundImages === "string") {
    try {
      const parsed: unknown = JSON.parse(data.backgroundImages);
      if (Array.isArray(parsed)) bgImages = parsed.filter((url): url is string => typeof url === "string");
    } catch {
      bgImages = [];
    }
  }

  const siteName = typeof data.siteName === "string" && data.siteName ? data.siteName : DEFAULT_SITE_NAME;
  const faviconUrl = typeof data.faviconUrl === "string" ? data.faviconUrl : "";
  const socialLinks = typeof data.socialLinks === "string"
    ? data.socialLinks
    : JSON.stringify(Array.isArray(data.socialLinks) ? data.socialLinks : []);

  return {
    postCollapseLength: typeof data.postCollapseLength === "number" ? data.postCollapseLength : 150,
    darkModeEnabled: typeof data.darkModeEnabled === "boolean" ? data.darkModeEnabled : false,
    darkModeStartTime: typeof data.darkModeStartTime === "string" ? data.darkModeStartTime : "18:00",
    darkModeEndTime: typeof data.darkModeEndTime === "string" ? data.darkModeEndTime : "06:00",
    siteName,
    faviconUrl,
    domain: typeof data.domain === "string" ? data.domain : "",
    socialLinks,
    beian: typeof data.beian === "string" ? data.beian : "",
    beianUrl: typeof data.beianUrl === "string" ? data.beianUrl : "",
    footerHtml: typeof data.footerHtml === "string" ? data.footerHtml : "",
    decorationImage: typeof data.decorationImage === "string" ? data.decorationImage : "",
    backgroundImages: bgImages,
    adOnArchives: typeof data.adOnArchives === "boolean" ? data.adOnArchives : false,
    defaultCover: typeof data.defaultCover === "string" ? data.defaultCover : "",
    musicAutoplay: typeof data.musicAutoplay === "boolean" ? data.musicAutoplay : false,
    loaded: true,
  };
}

export const useSiteSettings = create<SiteSettingsState>((set, get) => {
  const hydrateSettings = (data: unknown) => {
    const normalized = normalizeSettings(data);
    set(normalized);
    cacheDisplay(normalized.siteName, normalized.faviconUrl);
  };

  return {
    postCollapseLength: 150,
    darkModeEnabled: false,
    darkModeStartTime: "18:00",
    darkModeEndTime: "06:00",
    siteName: cachedDisplay.siteName,
    faviconUrl: cachedDisplay.faviconUrl,
    domain: "",
    socialLinks: "[]",
    beian: "",
    beianUrl: "",
    footerHtml: "",
    decorationImage: "",
    backgroundImages: [],
    adOnArchives: false,
    defaultCover: "",
    musicAutoplay: false,
    loaded: false,
    hydrateSettings,
    fetchSettings: async () => {
      if (get().loaded) return;
      if (settingsRequest) return settingsRequest;
      settingsRequest = (async () => {
        try {
          const API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";
          const res = await fetch(`${API_URL}/settings`, { cache: "no-store" });
          if (!res.ok) throw new Error("settings fetch failed");
          hydrateSettings(await res.json());
        } catch {
          set({ loaded: true });
        } finally {
          settingsRequest = null;
        }
      })();
      return settingsRequest;
    },
  };
});
