import type { Metadata } from 'next';
import './globals.css';
import { CommandPalette } from '@/components/CommandPalette';

export const metadata: Metadata = {
  title: 'Revenant Mini',
  description: 'Autonomous revenue recovery control plane for payments',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <CommandPalette />
      </body>
    </html>
  );
}
