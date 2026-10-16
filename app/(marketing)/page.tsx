import Link from 'next/link'
import {
  ArrowUpRight,
  Check,
  ChefHat,
  CircleCheck,
  CreditCard,
  LayoutGrid,
  Monitor,
  ReceiptText,
  ShieldCheck,
  Smartphone,
  Store,
  WifiOff,
} from 'lucide-react'
import './marketing.css'
import type { Metadata } from 'next'

export const metadata: Metadata = { alternates: { canonical: '/' } }

const dishes = [
  { image: 'I401383106A', name: 'Butter Chicken', category: 'Chicken special' },
  { image: 'I015725332A', name: 'Pav Bhaji', category: 'Veg special' },
  { image: 'I034443848A', name: 'Malpua with Rabdi', category: 'Sweets & bakery' },
]

const features = [
  {
    icon: LayoutGrid,
    title: 'A menu your team recognises',
    text: 'Photo-led ordering, categories, search, preparation notes and sale units. Familiar food, clearly organised.',
  },
  {
    icon: ReceiptText,
    title: 'Keep every order in view',
    text: 'Takeaway, dine-in and delivery order types. Hold a ticket, return to it and follow preparation in the local kitchen view.',
  },
  {
    icon: CreditCard,
    title: 'A clear end to every shift',
    text: 'Practise cash, recorded card and split payments. Review local sales, count closing cash and export your records.',
  },
]

export default function Landing() {
  return (
    <div className="ip-site">
      <a href="#main-content" className="ip-skip">
        Skip to content
      </a>
      <header className="ip-header ip-wrap">
        <Link href="/" className="ip-wordmark" aria-label="Internext POS home">
          <span className="ip-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>
            Internext <b>POS</b>
          </span>
        </Link>
        <nav aria-label="Main navigation">
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <Link href="/counter" className="ip-header-link">
            Staff sign in <ArrowUpRight size={17} aria-hidden="true" />
          </Link>
        </nav>
      </header>
      <main id="main-content">
        <section className="ip-hero ip-wrap">
          <div className="ip-hero-copy">
            <span className="ip-release">
              <span aria-hidden="true" /> Web training preview
            </span>
            <h1>Made for the rhythm of your restaurant.</h1>
            <p>
              A familiar menu. A clear order. An organised shift. Meet the restaurant POS we’re
              building for your counter and your next branch.
            </p>
            <div className="ip-actions">
              <Link href="/pos" className="ip-button">
                Open training workspace <ArrowUpRight size={19} aria-hidden="true" />
              </Link>
              <a href="#features" className="ip-text-link">
                Explore the features
              </a>
            </div>
            <div className="ip-hero-price">
              <strong>AED 100</strong>
              <span>
                per branch / month
                <br />
                All features. Multiple devices.
              </span>
            </div>
          </div>
          <div
            className="ip-preview"
            aria-label="Illustration of the menu in the training workspace"
          >
            <div className="ip-preview-top">
              <span>
                <Store size={18} aria-hidden="true" /> Your restaurant workspace
              </span>
              <span className="ip-preview-tag">Training</span>
            </div>
            <div className="ip-preview-body">
              <div className="ip-preview-heading">
                <div>
                  <span className="ip-preview-label">Suleman Usman Mithaiwala</span>
                  <h2>Good food. Clear orders.</h2>
                </div>
                <span className="ip-branch">Bur Dubai</span>
              </div>
              <div className="ip-preview-categories" aria-hidden="true">
                <span>On the menu</span>
                <span>Meals</span>
                <span>Sweets</span>
              </div>
              <div className="ip-dishes">
                {dishes.map((dish) => (
                  <div className="ip-dish" key={dish.image}>
                    <img
                      src={`/pos-assets/menu/${dish.image}.webp`}
                      alt=""
                      width={240}
                      height={180}
                    />
                    <div>
                      <small>{dish.category}</small>
                      <strong>{dish.name}</strong>
                    </div>
                  </div>
                ))}
              </div>
              <div className="ip-preview-order">
                <ReceiptText size={24} aria-hidden="true" />
                <div>
                  <strong>From the first order to closing time</strong>
                  <span>Menu · Orders · Kitchen · Cash & shifts</span>
                </div>
              </div>
            </div>
            <div className="ip-preview-foot">
              <ShieldCheck size={16} aria-hidden="true" />
              <span>Training only. No real payments are processed.</span>
            </div>
          </div>
        </section>
        <div className="ip-foundation">
          <div className="ip-wrap">
            <span>
              <Monitor size={21} aria-hidden="true" /> Web workspace first
            </span>
            <span>
              <WifiOff size={21} aria-hidden="true" /> Offline operation in development
            </span>
            <span>
              <Smartphone size={21} aria-hidden="true" /> Android APK next
            </span>
          </div>
        </div>
        <section id="features" className="ip-features ip-wrap">
          <div className="ip-section-heading">
            <div>
              <p className="ip-section-label">Inside the training workspace</p>
              <h2>
                Less searching.
                <br />
                More serving.
              </h2>
            </div>
            <p>
              Start with the work your team does every day. Explore the counter workflow using a
              real restaurant menu and sample transactions saved on this device.
            </p>
          </div>
          <div className="ip-feature-grid">
            {features.map(({ icon: Icon, title, text }) => (
              <article key={title}>
                <span className="ip-feature-icon">
                  <Icon size={26} strokeWidth={1.7} aria-hidden="true" />
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="ip-offline ip-wrap" aria-labelledby="offline-heading">
          <div className="ip-offline-copy">
            <span className="ip-section-label">Designed around the counter</span>
            <h2 id="offline-heading">
              The connection can wait.
              <br />
              Your customer shouldn’t.
            </h2>
            <p>
              Our offline design puts a copy of the working menu and order records on the POS
              device. Cloud synchronisation will follow, with a visible status for every order.
            </p>
            <p className="ip-honest-note">
              The current preview saves training data locally. Cloud sync, native printing and the
              Android APK are still to come. Offline use requires setup on the device first.
            </p>
          </div>
          <div
            className="ip-offline-diagram"
            aria-label="Planned flow: orders saved on device, then synchronised to the branch account when a connection is available"
          >
            <div className="ip-device-node">
              <Monitor size={34} strokeWidth={1.5} aria-hidden="true" />
              <strong>At your counter</strong>
              <span>Menu & order records</span>
              <small>
                <Check size={14} aria-hidden="true" /> Saved on this device
              </small>
            </div>
            <div className="ip-sync-path">
              <span />
              <span>When connected</span>
              <span />
            </div>
            <div className="ip-cloud-node">
              <Store size={29} strokeWidth={1.5} aria-hidden="true" />
              <strong>Your branch account</strong>
              <span>Cloud sync planned</span>
            </div>
          </div>
        </section>
        <section id="pricing" className="ip-pricing ip-wrap">
          <div className="ip-pricing-copy">
            <p className="ip-section-label">One straightforward subscription</p>
            <h2>
              Every feature.
              <br />
              One branch price.
            </h2>
            <p>
              Start with your first branch. Add another when your team is ready. Multiple devices
              are included in each branch subscription.
            </p>
            <ul>
              <li>
                <CircleCheck size={20} aria-hidden="true" /> All product features included as
                released
              </li>
              <li>
                <CircleCheck size={20} aria-hidden="true" /> Multiple POS devices per branch
              </li>
              <li>
                <CircleCheck size={20} aria-hidden="true" /> Manual subscription collection
                initially
              </li>
            </ul>
          </div>
          <div className="ip-price-panel">
            <span>Internext POS</span>
            <div className="ip-price">
              <span>AED</span>
              <strong>100</strong>
            </div>
            <p>per branch / month</p>
            <div className="ip-price-divider" />
            <p className="ip-price-description">
              Web first. Android next.
              <br />
              Built around your daily service.
            </p>
            <Link href="/pos" className="ip-button ip-button-light">
              Open training workspace <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
            <small>
              Preview available now. Commercial rollout follows pilot approval. Hardware and tax
              terms to be confirmed.
            </small>
          </div>
        </section>
        <section className="ip-rollout ip-wrap" aria-labelledby="rollout-heading">
          <div className="ip-rollout-icon">
            <ChefHat size={29} aria-hidden="true" />
          </div>
          <div>
            <h2 id="rollout-heading">Built with the first branch in mind.</h2>
            <p>
              Our first planned pilot is Abdul Gafoor Suleman Usman Mithaiwala Restaurant LLC, Bur
              Dubai. Menu confirmation, device testing and observed shifts come before live service.
            </p>
          </div>
          <span className="ip-rollout-status">Pilot preparation</span>
        </section>
      </main>
      <footer className="ip-footer ip-wrap">
        <Link href="/" className="ip-wordmark">
          Internext <b>POS</b>
        </Link>
        <p>Restaurant software, built for everyday service.</p>
        <span>Web preview · Android planned</span>
      </footer>
    </div>
  )
}
