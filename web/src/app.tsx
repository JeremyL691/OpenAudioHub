import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { Toaster } from "sonner";
// Loaded with the app, not lazily: its keyboard shortcuts must work the moment a page opens.
import Shell from "./components/shell/shell";

// One lazily loaded module per area, so each area owns its files (see web/README.md).
const Login = lazy(() => import("./pages/auth/login"));
const Register = lazy(() => import("./pages/auth/register"));
const Suspended = lazy(() => import("./pages/auth/suspended"));
const ForgotPassword = lazy(() => import("./pages/auth/forgot-password"));
const ResetPassword = lazy(() => import("./pages/auth/reset-password"));
const Landing = lazy(() => import("./pages/public/landing"));
const Install = lazy(() => import("./pages/public/install"));
const Docs = lazy(() => import("./pages/docs/docs"));
const Dashboard = lazy(() => import("./pages/dashboard/dashboard"));
const Library = lazy(() => import("./pages/library/library"));
const Recording = lazy(() => import("./pages/recording/recording"));
const Settings = lazy(() => import("./pages/settings/settings"));
const ConnectPlaud = lazy(() => import("./pages/settings/connect-plaud"));
const NotFound = lazy(() => import("./pages/not-found"));

export function App() {
    return (
        <BrowserRouter>
            <Suspense fallback={null}>
                <Routes>
                    <Route path="/" element={<Landing />} />
                    <Route path="/install" element={<Install />} />
                    <Route path="/docs" element={<Docs />} />
                    <Route path="/docs/*" element={<Docs />} />
                    <Route path="/login" element={<Login />} />
                    <Route path="/register" element={<Register />} />
                    <Route path="/forgot-password" element={<ForgotPassword />} />
                    <Route path="/reset-password" element={<ResetPassword />} />
                    <Route path="/suspended" element={<Suspended />} />
                    <Route path="/connect/plaud" element={<ConnectPlaud />} />
                    <Route element={<Shell />}>
                        <Route path="/dashboard" element={<Dashboard />} />
                        <Route path="/recordings" element={<Library />} />
                        <Route path="/recordings/:id" element={<Recording />} />
                        <Route path="/settings" element={<Settings />} />
                        <Route path="/settings/:section" element={<Settings />} />
                    </Route>
                    <Route path="*" element={<NotFound />} />
                </Routes>
            </Suspense>
            <Toaster position="bottom-right" />
        </BrowserRouter>
    );
}
