import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: 'https://pos.internext.info/', changeFrequency: 'weekly', priority: 1 }]
}
