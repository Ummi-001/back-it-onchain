"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Home, Search, PlusSquare, Bell, User, Trophy, Briefcase } from "lucide-react";
import { Logo } from "@/components/logo";
import { ChainSelector } from "@/components/ChainSelector";
import { useChain } from "@/components/ChainProvider";
import { NotificationBell } from "@/components/NotificationBell";
import { showInfoToast } from "@/components/tx-toast";
import { OmniboxSearch } from "@/src/components/OmniboxSearch";

import { cn } from "@/lib/utils";
import {
  Wallet,
  ConnectWallet,
  WalletDropdown,
  WalletDropdownDisconnect,
  WalletDropdownLink,
} from "@coinbase/onchainkit/wallet";
import {
  Address,
  Avatar,
  Name,
  Identity,
  EthBalance,
} from "@coinbase/onchainkit/identity";

export function Nav() {
  const t = useTranslations("Nav");
  const { selectedChain } = useChain();

  const pathname = usePathname();

  const navItems = [
    { icon: Home, label: t("home"), href: "/feed" },
    { icon: Search, label: t("explore"), href: "/explore" },
    { icon: Trophy, label: t("leaderboard"), href: "/leaderboard" },
    { icon: PlusSquare, label: t("create"), href: "/create" },
    { icon: Briefcase, label: t("portfolio"), href: "/portfolio" },
    { icon: Bell, label: t("activity"), href: "/activity" },
    { icon: User, label: t("profile"), href: "/profile" },
  ];

  return (
    <>
      <OmniboxSearch />
      {/* Desktop Sidebar */}
      <nav className="hidden md:flex sticky top-0 h-screen w-64 border-r border-border flex-col p-4 bg-background z-50 shrink-0">
        <div className="mb-8 px-2 flex justify-between items-center">
          <Logo />
          <NotificationBell />
        </div>

        <div className="flex-1 space-y-2">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-xl transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary font-bold"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                <item.icon
                  className={cn("h-6 w-6", isActive && "fill-current")}
                />
                <span className="text-lg">{item.label}</span>
              </Link>
            );
          })}
        </div>

        <div className="mt-auto pt-4 border-t border-border space-y-4">
          <div className="flex justify-center">
            <ChainSelector />
          </div>
          {selectedChain === "base" ? (
            <Wallet>
              <ConnectWallet className="w-full bg-secondary hover:bg-secondary/80 text-foreground">
                <Avatar className="h-6 w-6" />
                <Name />
              </ConnectWallet>
              <WalletDropdown>
                <Identity className="px-4 pt-3 pb-2" hasCopyAddressOnClick>
                  <Avatar />
                  <Name />
                  <Address />
                  <EthBalance />
                </Identity>
                <WalletDropdownLink
                  icon="link"
                  href="https://wallet.coinbase.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Wallet Settings
                </WalletDropdownLink>
                <WalletDropdownDisconnect />
              </WalletDropdown>
            </Wallet>
          ) : (
            <button
              onClick={() => showInfoToast({ title: "Coming soon", description: "Stellar wallet connection is coming soon!" })}
              className="w-full py-3 px-4 rounded-xl bg-white text-black font-bold flex items-center justify-center gap-2 hover:bg-gray-800 transition-all"
            >
              <div className="relative w-5 h-5">
                <Image
                  src="/icons/stellar.svg"
                  alt="Stellar"
                  fill
                  className="object-contain"
                />
              </div>
              {t("connect_stellar")}
            </button>
          )}
        </div>
      </nav>

      {/* Mobile Top Bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 border-b border-border bg-background/80 backdrop-blur-lg p-4 z-50 flex justify-between items-center">
        <Logo />
        <div className="flex items-center gap-2">
          <NotificationBell />
          <ChainSelector />
        </div>
      </div>

      {/* Mobile Bottom Nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 border-t border-border bg-background/80 backdrop-blur-lg p-2 z-50 flex justify-around items-center">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "p-3 rounded-xl transition-colors flex flex-col items-center gap-1",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:bg-secondary/50",
              )}
            >
              <item.icon
                className={cn("h-6 w-6", isActive && "fill-current")}
              />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
