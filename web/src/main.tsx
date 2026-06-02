import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { ClerkProvider, SignIn, SignUp, SignedIn, SignedOut, RedirectToSignIn, useAuth } from "@clerk/clerk-react";
import "./index.css";
import { App } from "./App";
import { Inbox } from "./pages/Inbox";
import { TxnDetail } from "./pages/TxnDetail";
import { Dashboard } from "./pages/Dashboard";
import { Notifications } from "./pages/Notifications";
import { Settings } from "./pages/Settings";
import { Onboarding } from "./pages/Onboarding";
import { QuickBooks } from "./pages/QuickBooks";
import { Reports } from "./pages/Reports";
import { Accounts } from "./pages/Accounts";
import { Reconcile } from "./pages/Reconcile";
import { setTokenGetter } from "./api";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 10_000 } },
});

// Bridges Clerk's getToken into the plain api.ts module so every /api call is Bearer-authed.
function TokenBridge() {
  const { getToken } = useAuth();
  setTokenGetter(() => getToken());
  return null;
}

// Centred card wrapper for the Clerk auth widgets.
function AuthScreen({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center bg-paper p-6">{children}</div>;
}

// Everything under "/" requires a signed-in user; signed-out visitors go to sign-in.
function Protected() {
  return (
    <>
      <SignedIn>
        <TokenBridge />
        <App />
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  );
}

const router = createBrowserRouter([
  {
    path: "/sign-in/*",
    element: (
      <AuthScreen>
        <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
      </AuthScreen>
    ),
  },
  {
    path: "/sign-up/*",
    element: (
      <AuthScreen>
        <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
      </AuthScreen>
    ),
  },
  {
    path: "/",
    element: <Protected />,
    children: [
      { index: true, element: <Inbox /> },
      { path: "txn/:id", element: <TxnDetail /> },
      { path: "dashboard", element: <Dashboard /> },
      { path: "accounts", element: <Accounts /> },
      { path: "reconcile", element: <Reconcile /> },
      { path: "notifications", element: <Notifications /> },
      { path: "settings", element: <Settings /> },
      { path: "onboarding", element: <Onboarding /> },
      { path: "quickbooks", element: <QuickBooks /> },
      { path: "reports", element: <Reports /> },
    ],
  },
]);

if (!PUBLISHABLE_KEY) {
  // Fail loudly at startup rather than silently shipping an unauthenticated app.
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is not set — see web/.env");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/sign-in">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ClerkProvider>
  </React.StrictMode>,
);
