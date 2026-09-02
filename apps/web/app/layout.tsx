import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Revenant Mini',
  description: 'Autonomous revenue recovery control plane for payments',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
