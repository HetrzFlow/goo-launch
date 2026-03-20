import { getToken } from "./api";
import { el } from "./dom-utils";
import {
  showWalletPicker,
  getConnectedAccount,
  getSelectedProvider,
  clearSelectedProvider,
  onAccountChanged,
} from "./wallet";
import { getAppConfig, getBscscanBase, isTestnet } from "./app-config";

// SVG icons
const ICON_WALLET = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z"/></svg>`;
const ICON_COPY = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICON_EXTERNAL = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICON_DISCONNECT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;
const ICON_FAUCET = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="M6 8h12l-1 8H7L6 8z"/><path d="M10 16v4"/><path d="M14 16v4"/><path d="M8 20h8"/></svg>`;

const MOCK_STABLE_ADDRESS = "0xd56BC53a49d3fd9c058bAc2c44570d9e3B4F6e07";
const MINT_AMOUNT = "1000"; // 1000 USDT per click

// Global wallet state accessible from other modules
export let navWalletAddress: string | null = null;
export const walletListeners: Array<(addr: string | null) => void> = [];

export function onWalletChange(fn: (addr: string | null) => void): void {
  walletListeners.push(fn);
}

function setNavWalletAddress(addr: string | null): void {
  navWalletAddress = addr;
  for (const fn of walletListeners) fn(addr);
}

/** Get the active EVM provider (set after wallet picker connects). */
export function getWalletProvider(): any {
  return getSelectedProvider();
}

// --- Wallet dropdown ---

let walletDropdown: HTMLElement | null = null;

function closeWalletDropdown(): void {
  if (walletDropdown) {
    walletDropdown.remove();
    walletDropdown = null;
  }
}

function showWalletDropdown(anchor: HTMLElement): void {
  closeWalletDropdown();
  if (!navWalletAddress) return;

  const dd = document.createElement("div");
  dd.style.cssText =
    "position:absolute;top:100%;right:0;margin-top:8px;background:#fff;border:1px solid #ebebeb;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.1);padding:12px;min-width:320px;z-index:9999;";

  // Header
  const header = el(
    "div",
    {
      style:
        "font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#B2B2B2;font-weight:600;margin-bottom:8px",
    },
    "Connected Wallet",
  );

  // Full address
  const addrBox = el(
    "div",
    {
      style:
        'font-family:"SF Mono","Fira Code",monospace;font-size:12px;color:#000;background:#f8f8f7;padding:10px 12px;border-radius:8px;word-break:break-all;line-height:1.6;margin-bottom:10px',
    },
    navWalletAddress,
  );

  // Action buttons row
  const actions = el("div", { style: "display:flex;gap:6px" });

  // Copy button
  const copyBtn = document.createElement("button");
  copyBtn.style.cssText =
    "flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;background:#f8f8f7;border:1px solid #ebebeb;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;color:#4D4D4D;transition:background .15s,border-color .15s;";
  const copyIcon = document.createElement("span");
  copyIcon.style.cssText = "display:flex;align-items:center";
  copyIcon.innerHTML = ICON_COPY;
  copyBtn.appendChild(copyIcon);
  copyBtn.appendChild(document.createTextNode("Copy"));
  copyBtn.addEventListener("mouseenter", () => {
    copyBtn.style.background = "#fff";
    copyBtn.style.borderColor = "#d0d0d0";
  });
  copyBtn.addEventListener("mouseleave", () => {
    copyBtn.style.background = "#f8f8f7";
    copyBtn.style.borderColor = "#ebebeb";
  });
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(navWalletAddress!);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = navWalletAddress!;
      ta.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    copyBtn.textContent = "";
    copyBtn.appendChild(document.createTextNode("Copied!"));
    setTimeout(() => {
      copyBtn.textContent = "";
      const ic = document.createElement("span");
      ic.style.cssText = "display:flex;align-items:center";
      ic.innerHTML = ICON_COPY;
      copyBtn.appendChild(ic);
      copyBtn.appendChild(document.createTextNode("Copy"));
    }, 1500);
  });

  // BSCScan link
  const scanBtn = document.createElement("a");
  scanBtn.href = `${getBscscanBase()}/address/${navWalletAddress}`;
  scanBtn.target = "_blank";
  scanBtn.rel = "noopener";
  scanBtn.style.cssText =
    "flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;background:#f8f8f7;border:1px solid #ebebeb;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;color:#4D4D4D;text-decoration:none;transition:background .15s,border-color .15s;";
  const scanIcon = document.createElement("span");
  scanIcon.style.cssText = "display:flex;align-items:center";
  scanIcon.innerHTML = ICON_EXTERNAL;
  scanBtn.appendChild(scanIcon);
  scanBtn.appendChild(document.createTextNode("BSCScan"));
  scanBtn.addEventListener("mouseenter", () => {
    scanBtn.style.background = "#fff";
    scanBtn.style.borderColor = "#d0d0d0";
  });
  scanBtn.addEventListener("mouseleave", () => {
    scanBtn.style.background = "#f8f8f7";
    scanBtn.style.borderColor = "#ebebeb";
  });

  // Switch wallet button
  const switchBtn = document.createElement("button");
  switchBtn.style.cssText =
    "flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;background:#f8f8f7;border:1px solid #ebebeb;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;color:#4D4D4D;transition:background .15s,border-color .15s;";
  const switchIcon = document.createElement("span");
  switchIcon.style.cssText = "display:flex;align-items:center";
  switchIcon.innerHTML = ICON_WALLET;
  switchBtn.appendChild(switchIcon);
  switchBtn.appendChild(document.createTextNode("Switch"));
  switchBtn.addEventListener("mouseenter", () => {
    switchBtn.style.background = "#fff";
    switchBtn.style.borderColor = "#d0d0d0";
  });
  switchBtn.addEventListener("mouseleave", () => {
    switchBtn.style.background = "#f8f8f7";
    switchBtn.style.borderColor = "#ebebeb";
  });
  switchBtn.addEventListener("click", async () => {
    closeWalletDropdown();
    clearSelectedProvider();
    try {
      const address = await showWalletPicker();
      setNavWalletAddress(address);
      updateWalletIcon(anchor as HTMLButtonElement);
    } catch {
      /* cancelled */
    }
  });

  // Disconnect button
  const disconnBtn = document.createElement("button");
  disconnBtn.style.cssText =
    "flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;background:#f8f8f7;border:1px solid #ebebeb;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;color:#e05050;transition:background .15s,border-color .15s;";
  const disconnIcon = document.createElement("span");
  disconnIcon.style.cssText = "display:flex;align-items:center";
  disconnIcon.innerHTML = ICON_DISCONNECT;
  disconnBtn.appendChild(disconnIcon);
  disconnBtn.appendChild(document.createTextNode("Disconnect"));
  disconnBtn.addEventListener("mouseenter", () => {
    disconnBtn.style.background = "#fdf5f5";
    disconnBtn.style.borderColor = "#f5d5d5";
  });
  disconnBtn.addEventListener("mouseleave", () => {
    disconnBtn.style.background = "#f8f8f7";
    disconnBtn.style.borderColor = "#ebebeb";
  });
  disconnBtn.addEventListener("click", () => {
    clearSelectedProvider();
    setNavWalletAddress(null);
    closeWalletDropdown();
    updateWalletIcon(anchor as HTMLButtonElement);
  });

  actions.appendChild(copyBtn);
  actions.appendChild(scanBtn);
  actions.appendChild(switchBtn);
  actions.appendChild(disconnBtn);

  dd.appendChild(header);
  dd.appendChild(addrBox);
  dd.appendChild(actions);

  // Close on outside click
  const onClickOutside = (e: MouseEvent) => {
    if (
      !dd.contains(e.target as Node) &&
      e.target !== anchor &&
      !anchor.contains(e.target as Node)
    ) {
      closeWalletDropdown();
      document.removeEventListener("click", onClickOutside);
    }
  };
  setTimeout(() => document.addEventListener("click", onClickOutside), 0);

  walletDropdown = dd;
  anchor.parentElement!.style.position = "relative";
  anchor.parentElement!.appendChild(dd);
}

// --- Wallet icon state ---

function updateWalletIcon(btn: HTMLButtonElement): void {
  btn.textContent = "";
  while (btn.firstChild) btn.removeChild(btn.firstChild);

  if (navWalletAddress) {
    btn.style.cssText =
      "display:flex;align-items:center;gap:6px;padding:6px 12px;background:#e6fafb;color:#00C7D2;border:1px solid #b2f0f4;border-radius:10px;font-family:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background .15s;";
    const dot = el("span", {
      style:
        "width:6px;height:6px;border-radius:50%;background:#00C7D2;flex-shrink:0",
    });
    btn.appendChild(dot);
    const iconSpan = document.createElement("span");
    iconSpan.style.cssText = "display:flex;align-items:center;color:#00C7D2";
    iconSpan.innerHTML = ICON_WALLET;
    btn.appendChild(iconSpan);
  } else {
    btn.style.cssText =
      "display:flex;align-items:center;padding:6px;background:none;border:none;cursor:pointer;color:#808080;transition:color .15s;";
    const iconSpan = document.createElement("span");
    iconSpan.style.cssText = "display:flex;align-items:center;";
    iconSpan.innerHTML = ICON_WALLET;
    btn.appendChild(iconSpan);
  }
}

export function renderNav(): void {
  const token = getToken();

  const nav = document.createElement("nav");
  nav.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;padding:12px 24px;border-bottom:1px solid #ebebeb;background:#fff;";

  if (token) {
    const linkStyle =
      "color:#808080;text-decoration:none;font-size:14px;transition:color .2s";

    // Wallet icon button
    const walletBtn = document.createElement("button");
    walletBtn.id = "nav-wallet-btn";
    updateWalletIcon(walletBtn);

    walletBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (navWalletAddress) {
        // Toggle dropdown
        if (walletDropdown) {
          closeWalletDropdown();
        } else {
          showWalletDropdown(walletBtn);
        }
      } else {
        try {
          const address = await showWalletPicker();
          setNavWalletAddress(address);
          updateWalletIcon(walletBtn);
        } catch {
          // User cancelled — do nothing
        }
      }
    });

    // Listen for external wallet changes
    onWalletChange(() => updateWalletIcon(walletBtn));

    // Listen for account changes from wallet extension (e.g. user switches account in MetaMask)
    onAccountChanged((addr) => {
      if (addr) {
        setNavWalletAddress(addr);
      } else {
        clearSelectedProvider();
        setNavWalletAddress(null);
      }
      closeWalletDropdown();
      updateWalletIcon(walletBtn);
    });

    // Faucet button (testnet only, hidden until config loads)
    const faucetBtn = document.createElement("button");
    faucetBtn.title = "Mint 1000 USDT (Testnet Faucet)";
    faucetBtn.style.cssText =
      "display:none;align-items:center;gap:5px;padding:6px 12px;background:#fef3c7;color:#b45309;border:1px solid #fde68a;border-radius:10px;font-family:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background .15s,border-color .15s;";
    getAppConfig().then((cfg) => {
      if (isTestnet(cfg)) faucetBtn.style.display = "flex";
    });
    const faucetIcon = document.createElement("span");
    faucetIcon.style.cssText = "display:flex;align-items:center";
    faucetIcon.innerHTML = ICON_FAUCET;
    faucetBtn.appendChild(faucetIcon);
    faucetBtn.appendChild(document.createTextNode("Faucet"));
    faucetBtn.addEventListener("mouseenter", () => {
      faucetBtn.style.background = "#fde68a";
    });
    faucetBtn.addEventListener("mouseleave", () => {
      faucetBtn.style.background = "#fef3c7";
    });
    faucetBtn.addEventListener("click", async () => {
      if (!navWalletAddress) {
        try {
          const address = await showWalletPicker();
          setNavWalletAddress(address);
          updateWalletIcon(walletBtn);
        } catch {
          return;
        }
      }
      const provider = getSelectedProvider();
      if (!provider || !navWalletAddress) return;
      faucetBtn.style.opacity = "0.6";
      faucetBtn.style.cursor = "wait";
      (faucetBtn as HTMLButtonElement).disabled = true;
      try {
        const iface = new (await import("ethers")).Interface([
          "function mint(address to, uint256 amount)",
          "function decimals() view returns (uint8)",
        ]);
        // Get decimals
        const decResult = await provider.request({
          method: "eth_call",
          params: [
            {
              to: MOCK_STABLE_ADDRESS,
              data: iface.encodeFunctionData("decimals"),
            },
            "latest",
          ],
        });
        const decimals = parseInt(decResult, 16);
        const amount = BigInt(MINT_AMOUNT) * 10n ** BigInt(decimals);
        const data = iface.encodeFunctionData("mint", [
          navWalletAddress,
          amount,
        ]);
        await provider.request({
          method: "eth_sendTransaction",
          params: [{ from: navWalletAddress, to: MOCK_STABLE_ADDRESS, data }],
        });
        faucetBtn.textContent = "";
        faucetBtn.appendChild(document.createTextNode("Minted!"));
        setTimeout(() => {
          faucetBtn.textContent = "";
          const ic = document.createElement("span");
          ic.style.cssText = "display:flex;align-items:center";
          ic.innerHTML = ICON_FAUCET;
          faucetBtn.appendChild(ic);
          faucetBtn.appendChild(document.createTextNode("Faucet"));
        }, 2000);
      } catch (err: any) {
        console.error("Faucet mint failed:", err);
        faucetBtn.textContent = "";
        faucetBtn.appendChild(document.createTextNode("Failed"));
        setTimeout(() => {
          faucetBtn.textContent = "";
          const ic = document.createElement("span");
          ic.style.cssText = "display:flex;align-items:center";
          ic.innerHTML = ICON_FAUCET;
          faucetBtn.appendChild(ic);
          faucetBtn.appendChild(document.createTextNode("Faucet"));
        }, 2000);
      } finally {
        faucetBtn.style.opacity = "1";
        faucetBtn.style.cursor = "pointer";
        (faucetBtn as HTMLButtonElement).disabled = false;
      }
    });

    // Wallet button wrapper (for dropdown positioning)
    const walletWrap = el("span", {
      style: "position:relative;display:flex;align-items:center",
    });
    walletWrap.appendChild(walletBtn);

    // Left: logo
    const logoLink = el("a", {
      href: "/",
      style: "display:flex;align-items:center;text-decoration:none",
    });
    const logoImg = document.createElement("img");
    logoImg.src = "/logo.svg";
    logoImg.alt = "Goo Economy";
    logoImg.style.cssText = "height:28px;width:auto;border-radius:4px";
    logoLink.appendChild(logoImg);

    // Center: nav tabs
    const navTabs = el(
      "span",
      { style: "display:flex;gap:16px;align-items:center" },
      el("a", { href: "/", style: linkStyle }, "All Goo"),
      el("a", { href: "/launch.html", style: linkStyle }, "Launch Goo"),
      el("a", { href: "/dashboard.html", style: linkStyle }, "My Goo"),
      el("a", { href: "/all.html", style: linkStyle }, "Goo Dashboard"),
    );

    // External links
    const externalLinkStyle =
      "color:#B2B2B2;text-decoration:none;font-size:13px;transition:color .2s";
    const externalLinks = el(
      "span",
      {
        style:
          "display:flex;gap:12px;align-items:center;margin-left:8px;padding-left:12px;border-left:1px solid #ebebeb",
      },
      el(
        "a",
        {
          href: "https://goo.hertzflow.xyz/",
          target: "_blank",
          rel: "noopener",
          style: externalLinkStyle,
        },
        "Docs",
      ),
      el(
        "a",
        {
          href: "https://github.com/HertzFlow/goo-example",
          target: "_blank",
          rel: "noopener",
          style: externalLinkStyle,
        },
        "GitHub",
      ),
      el(
        "a",
        {
          href: "https://x.com/hertzflow_xyz",
          target: "_blank",
          rel: "noopener",
          style: externalLinkStyle,
        },
        "X",
      ),
    );
    navTabs.appendChild(externalLinks);

    // Highlight active nav link
    const currentPath = window.location.pathname;
    navTabs.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("href");
      if (
        href === currentPath ||
        (href === "/" && currentPath === "/index.html")
      ) {
        (a as HTMLElement).style.cssText =
          "background:#F3F4F6;font-weight:600;border-radius:8px;padding:6px 12px;color:#000;text-decoration:none;font-size:14px";
      }
    });

    // Right: faucet, wallet
    const rightGroup = el(
      "span",
      { style: "display:flex;gap:10px;align-items:center" },
      faucetBtn,
      walletWrap,
    );

    nav.appendChild(logoLink);
    nav.appendChild(navTabs);
    nav.appendChild(rightGroup);
  } else {
    const logoLink2 = el("a", {
      href: "/",
      style: "display:flex;align-items:center;text-decoration:none",
    });
    const logoImg2 = document.createElement("img");
    logoImg2.src = "/logo.svg";
    logoImg2.alt = "Goo Economy";
    logoImg2.style.cssText = "height:28px;width:auto;border-radius:4px";
    logoLink2.appendChild(logoImg2);

    const linkStyle2 =
      "color:#808080;text-decoration:none;font-size:14px;transition:color .2s";
    const externalLinkStyle2 =
      "color:#B2B2B2;text-decoration:none;font-size:13px;transition:color .2s";
    const navTabs2 = el(
      "span",
      { style: "display:flex;gap:16px;align-items:center" },
      el(
        "a",
        {
          href: "https://goo.hertzflow.xyz/",
          target: "_blank",
          rel: "noopener",
          style: linkStyle2,
        },
        "Docs",
      ),
      el(
        "a",
        {
          href: "https://github.com/HertzFlow/goo-example",
          target: "_blank",
          rel: "noopener",
          style: externalLinkStyle2,
        },
        "GitHub",
      ),
      el(
        "a",
        {
          href: "https://x.com/hertzflow_xyz",
          target: "_blank",
          rel: "noopener",
          style: externalLinkStyle2,
        },
        "X",
      ),
    );

    const loginLink = document.createElement("a");
    loginLink.href = "/login.html";
    loginLink.style.cssText =
      "display:flex;align-items:center;padding:6px;color:#808080;transition:color .15s;";
    loginLink.title = "Connect Wallet";
    loginLink.innerHTML = ICON_WALLET;
    const loginSpan = el("span");
    loginSpan.appendChild(loginLink);

    nav.appendChild(logoLink2);
    nav.appendChild(navTabs2);
    nav.appendChild(loginSpan);
  }

  document.body.prepend(nav);

  // Auto-detect already connected wallet
  (async () => {
    try {
      const result = await getConnectedAccount();
      if (result) {
        setNavWalletAddress(result.address);
        const btn = document.getElementById(
          "nav-wallet-btn",
        ) as HTMLButtonElement | null;
        if (btn) updateWalletIcon(btn);
      }
    } catch {}
  })();
}
