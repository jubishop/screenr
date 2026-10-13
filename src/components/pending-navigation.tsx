"use client";
import NextLink, { useLinkStatus } from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
} from "react";

// Each client navigation waits for the server to render the next member
// screen, while the current one stays in place. Pending links and other
// navigations report to the screen around them so it can show that wait.
type Report = () => () => void;
export const NavigationReports = createContext<Report>(() => () => {});

// Whether a navigation is waiting, and the report for NavigationReports. Each
// screen counts its own reports, so the next screen starts without the wait.
export function usePendingNavigations() {
  const [waiting, setWaiting] = useState(0);
  const report = useCallback(() => {
    setWaiting((count) => count + 1);
    return () => setWaiting((count) => count - 1);
  }, []);
  return [waiting > 0, report] as const;
}

// Reports a navigation while it is pending, such as a transition that wraps
// router.push.
export function useReportNavigation(pending: boolean) {
  const report = useContext(NavigationReports);
  useEffect(() => (pending ? report() : undefined), [pending, report]);
}

function LinkStatus() {
  useReportNavigation(useLinkStatus().pending);
  return null;
}

// next/link, reporting its navigation while the next screen loads.
export function Link({ children, ...props }: ComponentProps<typeof NextLink>) {
  return (
    <NextLink {...props}>
      {children}
      <LinkStatus />
    </NextLink>
  );
}
