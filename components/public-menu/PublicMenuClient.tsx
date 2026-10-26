'use client'

/* eslint-disable @next/next/no-img-element -- menu photos and generated QR data are local, trusted display assets. */

import { Download, Printer, Search, UtensilsCrossed } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { PublicMenu, PublicMenuItem } from '@/lib/pos/server/public-menu'

import styles from './public-menu.module.css'

function price(fils: number) {
  return new Intl.NumberFormat('en-AE', {
    style: 'currency',
    currency: 'AED',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(fils / 100)
}

function unitLabel(unit: PublicMenuItem['unit']) {
  if (unit === 'kg') return 'per kg'
  if (unit === 'pack') return 'per pack'
  return 'each'
}

export function PublicMenuClient({
  menu,
  qrDataUrl,
  menuUrl,
}: {
  menu: PublicMenu
  qrDataUrl: string
  menuUrl: string
}) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const categories = useMemo(
    () => Array.from(new Set(menu.items.map((item) => item.category))),
    [menu.items]
  )
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return menu.items.filter(
      (item) =>
        (category === 'All' || item.category === category) &&
        (!needle || `${item.name} ${item.category}`.toLocaleLowerCase().includes(needle))
    )
  }, [category, menu.items, query])

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.brandRow}>
          <img className={styles.brandMark} src="/pos-assets/brand/mithaiwala.webp" alt="" />
          <p className={styles.eyebrow}>Bur Dubai · Digital menu</p>
        </div>
        <h1>{menu.displayName}</h1>
        <p className={styles.intro}>
          Browse the current available menu and prices. Please place your order with the restaurant
          team.
        </p>
        <div className={styles.heroActions}>
          <button type="button" onClick={() => window.print()} className={styles.secondaryAction}>
            <Printer size={17} aria-hidden="true" /> Print menu
          </button>
          <a
            href={qrDataUrl}
            download={`${menu.slug}-menu-qr.png`}
            className={styles.secondaryAction}
          >
            <Download size={17} aria-hidden="true" /> Save QR
          </a>
        </div>
      </section>

      <section className={styles.qrCard} aria-label="Menu QR code">
        <img src={qrDataUrl} alt={`QR code for the ${menu.displayName} menu`} />
        <div>
          <strong>Scan for this menu</strong>
          <span>{menuUrl}</span>
        </div>
      </section>

      <section className={styles.menuSection} aria-label="Menu items">
        <label className={styles.search}>
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Search the menu</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search dishes"
          />
        </label>
        <div className={styles.categories} aria-label="Menu categories">
          {['All', ...categories].map((value) => (
            <button
              type="button"
              key={value}
              className={value === category ? styles.selectedCategory : undefined}
              aria-pressed={value === category}
              onClick={() => setCategory(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <p className={styles.count}>
          {visible.length} {visible.length === 1 ? 'item' : 'items'}
        </p>
        {visible.length ? (
          <div className={styles.grid}>
            {visible.map((item) => (
              <article className={styles.card} key={item.id}>
                <div className={styles.imageWrap}>
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt={item.imageAlt} loading="lazy" />
                  ) : (
                    <UtensilsCrossed aria-label="Photo unavailable" />
                  )}
                  {item.imageLabel ? <span>{item.imageLabel}</span> : null}
                </div>
                <div className={styles.cardBody}>
                  <p className={styles.category}>{item.category}</p>
                  <h2>{item.name}</h2>
                  <p className={styles.price}>
                    {price(item.unitPriceFils)} <small>{unitLabel(item.unit)}</small>
                  </p>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className={styles.empty}>No matching dishes. Try another name or category.</div>
        )}
      </section>
      <footer className={styles.footer}>
        Prices and availability are shown from the live branch menu. VAT is included where
        applicable.
      </footer>
    </main>
  )
}
