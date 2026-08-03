import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WooCommerce Audit Log',
  description: 'Audit trail of product changes made in WooCommerce.',
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
