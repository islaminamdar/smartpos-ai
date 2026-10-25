import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/billing',
        '/dashboard',
        '/kds',
        '/login',
        '/onboarding',
        '/order',
        '/signup',
        '/staff/',
      ],
    },
    sitemap: 'https://pos.internext.info/sitemap.xml',
    host: 'https://pos.internext.info',
  }
}
