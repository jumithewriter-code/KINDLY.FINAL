import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { IconSprite } from './components/Icon';
import { DemoNotice } from './components/DemoNotice';
import { LoadingState } from './components/ui';
import {
  AnnouncerProvider, AuthProvider, BackendProvider, ChildSessionProvider,
  WorkspaceProvider, useAuth, useWorkspace,
} from './state/providers';
import type { KindlyBackend } from './lib/backend';

import { AuthPage } from './routes/auth/AuthPage';
import { ForgotPasswordPage } from './routes/auth/ForgotPasswordPage';
import { ResetPasswordPage } from './routes/auth/ResetPasswordPage';
import { CheckEmailPage } from './routes/auth/CheckEmailPage';
import { AcceptInvitePage } from './routes/auth/AcceptInvitePage';
import { OnboardingPage } from './routes/onboarding/OnboardingPage';
import { AppShell } from './routes/app/AppShell';
import { HomePage } from './routes/app/HomePage';
import { RequestsPage } from './routes/app/RequestsPage';
import { RequestDetailPage } from './routes/app/RequestDetailPage';
import { StoriesPage } from './routes/app/StoriesPage';
import { StoryEditorPage } from './routes/app/StoryEditorPage';
import { RoutinesPage } from './routes/app/RoutinesPage';
import { RoutineEditorPage } from './routes/app/RoutineEditorPage';
import { ProfilePage } from './routes/app/ProfilePage';
import { SettingsPage } from './routes/app/SettingsPage';
import { AdminPage } from './routes/app/AdminPage';
import { CaregiversSettingsPage } from './routes/app/settings/CaregiversSettingsPage';
import { ChildrenSettingsPage } from './routes/app/settings/ChildrenSettingsPage';
import { PreferencesSettingsPage } from './routes/app/settings/PreferencesSettingsPage';
import { SafetySettingsPage } from './routes/app/settings/SafetySettingsPage';
import { NotificationsSettingsPage } from './routes/app/settings/NotificationsSettingsPage';
import { DataSettingsPage } from './routes/app/settings/DataSettingsPage';
import { ChildShell } from './routes/child/ChildShell';
import { ChildHomePage } from './routes/child/ChildHomePage';
import { ChildHelpPage } from './routes/child/ChildHelpPage';
import { ChildRequestPage } from './routes/child/ChildRequestPage';
import { ChildFeelingsPage } from './routes/child/ChildFeelingsPage';
import { ChildStoriesPage } from './routes/child/ChildStoriesPage';
import { ChildStoryReaderPage } from './routes/child/ChildStoryReaderPage';
import { ChildDayPage } from './routes/child/ChildDayPage';
import { ChildRoutineRunnerPage } from './routes/child/ChildRoutineRunnerPage';
import { ChildOfflineHelpPage } from './routes/child/ChildOfflineHelpPage';
import { ChildExitPage } from './routes/child/ChildExitPage';
import { NotFoundPage } from './routes/NotFoundPage';

/** Sends people to the right place without ever losing where they were going. */
function RequireAuth({ children }: { children: JSX.Element }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <LoadingState label="Opening your space" />;
  if (status === 'signed-out') {
    return <Navigate to="/auth/sign-in" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}

/** A caregiver with no family yet always lands in onboarding. */
function RequireFamily({ children }: { children: JSX.Element }) {
  const { workspace, isLoading } = useWorkspace();
  if (isLoading) return <LoadingState label="Opening your space" />;
  if (workspace && !workspace.activeFamilyId) return <Navigate to="/onboarding" replace />;
  return children;
}

function RootRedirect() {
  const { status } = useAuth();
  const { workspace, isLoading } = useWorkspace();
  if (status === 'loading' || (status === 'signed-in' && isLoading)) {
    return <LoadingState label="Opening your space" />;
  }
  if (status === 'signed-out') return <Navigate to="/auth/sign-in" replace />;
  if (workspace && !workspace.activeFamilyId) return <Navigate to="/onboarding" replace />;
  return <Navigate to="/app" replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />

      <Route path="/auth/sign-in" element={<AuthPage mode="sign-in" />} />
      <Route path="/auth/create-account" element={<AuthPage mode="create-account" />} />
      <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/auth/reset" element={<ResetPasswordPage />} />
      <Route path="/auth/check-email" element={<CheckEmailPage />} />
      <Route path="/auth/callback" element={<RootRedirect />} />
      <Route path="/invite/:token" element={<AcceptInvitePage />} />

      <Route path="/onboarding" element={<RequireAuth><OnboardingPage /></RequireAuth>} />
      <Route path="/onboarding/:step" element={<RequireAuth><OnboardingPage /></RequireAuth>} />

      <Route path="/app" element={<RequireAuth><RequireFamily><AppShell /></RequireFamily></RequireAuth>}>
        <Route index element={<HomePage />} />
        <Route path="requests" element={<RequestsPage />} />
        <Route path="requests/:requestId" element={<RequestDetailPage />} />
        <Route path="stories" element={<StoriesPage />} />
        <Route path="stories/new" element={<StoryEditorPage mode="new" />} />
        <Route path="stories/:storyId" element={<StoryEditorPage mode="edit" />} />
        <Route path="routines" element={<RoutinesPage />} />
        <Route path="routines/new" element={<RoutineEditorPage mode="new" />} />
        <Route path="routines/:routineId" element={<RoutineEditorPage mode="edit" />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/caregivers" element={<CaregiversSettingsPage />} />
        <Route path="settings/children" element={<ChildrenSettingsPage />} />
        <Route path="settings/preferences" element={<PreferencesSettingsPage />} />
        <Route path="settings/safety" element={<SafetySettingsPage />} />
        <Route path="settings/notifications" element={<NotificationsSettingsPage />} />
        <Route path="settings/data" element={<DataSettingsPage />} />
        <Route path="admin" element={<AdminPage />} />
      </Route>

      <Route path="/child" element={<RequireAuth><ChildShell /></RequireAuth>}>
        <Route index element={<ChildHomePage />} />
        <Route path="help" element={<ChildHelpPage />} />
        <Route path="request/:requestId" element={<ChildRequestPage />} />
        <Route path="feelings" element={<ChildFeelingsPage />} />
        <Route path="stories" element={<ChildStoriesPage />} />
        <Route path="stories/:storyId" element={<ChildStoryReaderPage />} />
        <Route path="day" element={<ChildDayPage />} />
        <Route path="day/:routineId" element={<ChildRoutineRunnerPage />} />
        <Route path="offline-help" element={<ChildOfflineHelpPage />} />
        <Route path="exit" element={<ChildExitPage />} />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export function App({ backend }: { backend?: KindlyBackend }) {
  return (
    <BackendProvider backend={backend}>
      <AnnouncerProvider>
        <AuthProvider>
          <WorkspaceProvider>
            <ChildSessionProvider>
              <IconSprite />
              <a className="skip-link" href="#main-content">Skip to main content</a>
              <DemoNotice />
              <AppRoutes />
            </ChildSessionProvider>
          </WorkspaceProvider>
        </AuthProvider>
      </AnnouncerProvider>
    </BackendProvider>
  );
}
