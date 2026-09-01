import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'gaussian · Reconstruction Workspace',
  description: '视频与多视角图片转 3D Gaussian Splatting 的 Ubuntu 建模工作台。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
