import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 10_000 } },
});

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Inbox /> },
      { path: "txn/:id", element: <TxnDetail /> },
      { path: "dashboard", element: <Dashboard /> },
      { path: "notifications", element: <Notifications /> },
      { path: "settings", element: <Settings /> },
      { path: "onboarding", element: <Onboarding /> },
      { path: "quickbooks", element: <QuickBooks /> },
      { path: "reports", element: <Reports /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
