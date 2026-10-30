import "./globals.css";
export const metadata = { title: "Chanpro Admin", robots: "noindex,nofollow" };
export default function RootLayout({ children }) {
  return <html lang="ja"><body>{children}</body></html>;
}
