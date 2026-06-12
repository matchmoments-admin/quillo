import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

/**
 * UI state for the floating "Ask Quillo" widget — open/closed + an unread badge — lifted into a
 * context so ANY page can open the chat (e.g. a future "Ask Quillo about this" affordance) without
 * the widget remounting. The conversation itself lives in <FloatingChat/> (the assistant-ui runtime);
 * this context is deliberately tiny and message-free. Mounted once near the app root, so its state —
 * and therefore the open panel and its scroll position — survives client-side route changes.
 */
type ChatUI = {
  open: boolean;
  openChat: () => void;
  closeChat: () => void;
  toggle: () => void;
  unread: number;
  bumpUnread: () => void;
  clearUnread: () => void;
};

const ChatUICtx = createContext<ChatUI>({
  open: false,
  openChat: () => {},
  closeChat: () => {},
  toggle: () => {},
  unread: 0,
  bumpUnread: () => {},
  clearUnread: () => {},
});

export const useChatUI = (): ChatUI => useContext(ChatUICtx);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const openChat = useCallback(() => {
    setOpen(true);
    setUnread(0);
  }, []);
  const closeChat = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const bumpUnread = useCallback(() => setUnread((n) => n + 1), []);
  const clearUnread = useCallback(() => setUnread(0), []);

  const value = useMemo<ChatUI>(
    () => ({ open, openChat, closeChat, toggle, unread, bumpUnread, clearUnread }),
    [open, openChat, closeChat, toggle, unread, bumpUnread, clearUnread],
  );

  return <ChatUICtx.Provider value={value}>{children}</ChatUICtx.Provider>;
}
