import Link from 'next/link'
import type { Metadata } from 'next'
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  CreditCard,
  LayoutGrid,
  Monitor,
  ReceiptText,
  Search,
  ShieldCheck,
  Smartphone,
  Store,
  Tag,
  Utensils,
  Wallet,
  WifiOff,
} from 'lucide-react'
import './marketing.css'

export const metadata: Metadata = {
  alternates: { canonical: '/' },
  title: { absolute: 'Restaurant POS Dubai & Retail Demos | Internext' },
  description:
    'Online restaurant POS software in Dubai, with configured retail demos. Sales, stock, receipt details and shifts for US$100 per branch per month.',
  openGraph: {
    title: 'Restaurant POS Dubai with Configured Retail Demos | Internext',
    description:
      'Explore the online restaurant POS and configured retail demos. US$100 per branch per month. Android offline use is in development.',
    type: 'website',
    url: 'https://pos.internext.info/',
    siteName: 'Internext POS',
    images: [
      {
        url: '/pos-share.png',
        width: 1200,
        height: 630,
        alt: 'Internext POS sales and stock workspace',
      },
    ],
  },
}

const faqItems = [
  {
    question: 'What is Internext POS?',
    answer:
      'Internext POS is online point-of-sale software from Internext Information Technology in Dubai. It brings counter sales, stock records, receipts, offers, refunds and shift closing into one workspace.',
  },
  {
    question: 'How much does the POS software cost?',
    answer:
      'Internext POS costs US$100 per branch per month. Multiple staff and counter devices are included. POS hardware, payment-terminal fees, custom integrations and agreed setup work are separate.',
  },
  {
    question: 'Which businesses can use Internext POS?',
    answer:
      'The released online workflow is built around restaurants and cafés. Grocery, convenience, pet-shop and general retail configurations can be reviewed and configured for the business. Salon, wholesale, medical and pharmacy workflows require a suitability review.',
  },
  {
    question: 'Does Internext POS support UAE VAT receipts?',
    answer:
      'The online pilot records sales and issues numbered receipts with VAT details configured for the branch. The business remains responsible for confirming its tax setup and receipt requirements.',
  },
  {
    question: 'Can I use the counter without internet?',
    answer:
      'No. The current live counter requires an internet connection. Offline live billing and the production Android APK are still in development.',
  },
  {
    question: 'Does recording a card payment charge the customer?',
    answer:
      'No. A card payment is recorded in the POS after it is taken through the business’s separate card terminal. Internext POS does not currently process the customer’s card.',
  },
  {
    question: 'Can I try the POS before subscribing?',
    answer:
      'Yes. The training workspace lets you explore a sample menu and sample transactions without creating a real sale, charging a card or issuing a valid tax invoice.',
  },
]

const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': 'https://internext.info/#organization',
      name: 'Internext Information Technology',
      url: 'https://internext.info/',
      telephone: '+971557133786',
      address: { '@type': 'PostalAddress', addressLocality: 'Dubai', addressCountry: 'AE' },
      areaServed: [
        { '@type': 'City', name: 'Dubai' },
        { '@type': 'Country', name: 'United Arab Emirates' },
      ],
    },
    {
      '@type': 'SoftwareApplication',
      '@id': 'https://pos.internext.info/#software',
      name: 'Internext POS',
      url: 'https://pos.internext.info/',
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'Point of Sale Software',
      operatingSystem: 'Web browser',
      description:
        'Online point-of-sale software released for restaurant counters in Dubai, with configured retail demos and workflow review.',
      provider: { '@id': 'https://internext.info/#organization' },
      areaServed: 'United Arab Emirates',
      offers: {
        '@type': 'Offer',
        price: '100',
        priceCurrency: 'USD',
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price: '100',
          priceCurrency: 'USD',
          unitText: 'branch per month',
        },
        url: 'https://pos.internext.info/#pricing',
      },
      featureList: [
        'Counter sales',
        'Stock records',
        'VAT receipt details',
        'Offers and refunds',
        'Shift closing',
        'Multiple devices per branch',
      ],
    },
    {
      '@type': 'FAQPage',
      '@id': 'https://pos.internext.info/#faq',
      mainEntity: faqItems.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: { '@type': 'Answer', text: item.answer },
      })),
    },
  ],
}

const dishes = [
  { image: 'I401383106A', name: 'Butter Chicken', category: 'Chicken special' },
  { image: 'I015725332A', name: 'Pav Bhaji', category: 'Veg special' },
  { image: 'I034443848A', name: 'Malpua with Rabdi', category: 'Sweets & bakery' },
]
const industryPreviews = [
  {
    image: 'restaurant',
    title: 'Restaurants & cafés',
    text: 'Menus, tables, open orders and kitchen dispatch.',
    status: 'Available online',
  },
  {
    image: 'grocery',
    title: 'Grocery & convenience',
    text: 'Piece, pack, kilogram and litre-based sales.',
    status: 'Demo configuration',
  },
  {
    image: 'pet-shop',
    title: 'Pet shops',
    text: 'Products, stock levels, offers and receipt history.',
    status: 'Demo configuration',
  },
  {
    image: 'fashion',
    title: 'Fashion & retail',
    text: 'Collections, product options, offers and returns.',
    status: 'Demo configuration',
  },
  {
    image: 'salon',
    title: 'Salons & services',
    text: 'Services and retail products in one checkout.',
    status: 'Workflow review',
  },
  {
    image: 'wholesale',
    title: 'Wholesale',
    text: 'Bulk quantities, receiving, adjustments and reports.',
    status: 'Workflow review',
  },
]
const steps = [
  {
    icon: LayoutGrid,
    title: 'Find it. Add it.',
    text: 'A photo menu, clear categories and quantities by piece, pack or weight.',
  },
  {
    icon: CreditCard,
    title: 'Take payment. Keep the record.',
    text: 'Record cash, card or a split payment. Issue a receipt with the sale and VAT details.',
  },
  {
    icon: Wallet,
    title: 'Count cash. Close the shift.',
    text: 'Track cash movements and refunds, then compare the drawer with the expected balance.',
  },
]
const availability = [
  {
    title: 'Staff, branches & devices',
    detail: 'Staff sign-in, branch access and counter device registration.',
    status: 'Online pilot',
    ready: true,
  },
  {
    title: 'Sales, offers & cash control',
    detail:
      'Cash and recorded card payments, offers, VAT receipts, full refunds and shift closing.',
    status: 'Online pilot',
    ready: true,
  },
  {
    title: 'Shared orders, tables & kitchen',
    detail:
      'Share unpaid orders and tables across counters. Send items to the kitchen before payment and track additions without repeating served food.',
    status: 'Online pilot',
    ready: true,
  },
  {
    title: 'Offline APK & subscriptions',
    detail: 'Offline sales on Android and recurring PayPal billing are being developed.',
    status: 'In development',
    ready: false,
  },
]

function Wordmark() {
  return (
    <Link href="/" className="ip-wordmark" aria-label="Internext POS home">
      <span className="ip-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>
        Internext <b>POS</b>
      </span>
    </Link>
  )
}

export default function Landing() {
  return (
    <div className="ip-site">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, '\\u003c'),
        }}
      />
      <a href="#main-content" className="ip-skip">
        Skip to content
      </a>
      <header className="ip-header ip-wrap">
        <Wordmark />
        <nav aria-label="Main navigation" className="ip-nav">
          <a href="#workflow">How it works</a>
          <a href="#pricing">Pricing</a>
          <Link href="/pos">Training</Link>
        </nav>
        <Link href="/counter" className="ip-staff-link">
          Staff sign in <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </header>
      <main id="main-content">
        <section className="ip-hero ip-wrap" aria-labelledby="hero-title">
          <div className="ip-hero-copy">
            <p className="ip-release">
              <Store size={16} aria-hidden="true" /> Smart POS · Restaurants &amp; retail
            </p>
            <h1 id="hero-title">Run your Dubai restaurant counter with clarity.</h1>
            <p className="ip-intro">
              Internext POS is online restaurant POS software that brings counter sales, stock,
              receipt details and shift records into one workspace. Retail businesses can request a
              configured demo and workflow review.
            </p>
            <div className="ip-actions">
              <a
                href="https://wa.me/971557133786?text=Hi%20Internext%2C%20I%27d%20like%20to%20book%20a%20Smart%20AI%20POS%20demo."
                className="ip-button"
              >
                Book a live demo <ArrowRight size={18} aria-hidden="true" />
              </a>
              <Link href="/pos" className="ip-button ip-button-outline">
                Explore training
              </Link>
            </div>
            <p className="ip-access-note">
              Staff counter requires an account. Training uses separate sample records.
            </p>
            <div className="ip-hero-plan">
              <span>
                <strong>US$100</strong> / branch / month
              </span>
              <span>Multiple devices included</span>
            </div>
          </div>
          <figure className="ip-counter-preview">
            <div className="ip-preview-chrome">
              <span>
                <span className="ip-mini-mark" aria-hidden="true" /> Internext POS
              </span>
              <span>Counter illustration</span>
            </div>
            <div className="ip-preview-main">
              <div className="ip-preview-heading">
                <div>
                  <span>Suleman Usman Mithaiwala</span>
                  <h2>What are we serving?</h2>
                </div>
                <span className="ip-preview-branch">
                  <Store size={13} aria-hidden="true" /> Bur Dubai
                </span>
              </div>
              <div className="ip-preview-search">
                <Search size={15} aria-hidden="true" />
                <span>Find a dish in your menu</span>
                <span aria-hidden="true">⌕</span>
              </div>
              <div className="ip-preview-categories">
                <span>All items</span>
                <span>Meals</span>
                <span>Savouries</span>
                <span>Sweets</span>
              </div>
              <div className="ip-dishes">
                {dishes.map((dish) => (
                  <div className="ip-dish" key={dish.image}>
                    <img
                      src={`/pos-assets/menu/${dish.image}.webp`}
                      alt={dish.name}
                      width={258}
                      height={294}
                      loading="eager"
                    />
                    <div>
                      <small>{dish.category}</small>
                      <strong>{dish.name}</strong>
                    </div>
                  </div>
                ))}
              </div>
              <div className="ip-preview-bottom">
                <div className="ip-order-summary">
                  <Utensils size={21} aria-hidden="true" />
                  <div>
                    <strong>Your order, clearly laid out.</strong>
                    <span>Items · quantities · payment</span>
                  </div>
                </div>
                <span className="ip-preview-payment">
                  Review order <ChevronRight size={16} aria-hidden="true" />
                </span>
              </div>
            </div>
            <figcaption>
              <ReceiptText size={17} aria-hidden="true" /> A familiar menu at the counter. A clear
              record after every sale.
            </figcaption>
          </figure>
        </section>
        <section className="ip-answer ip-wrap" aria-labelledby="pos-answer-title">
          <span>Point of sale, explained</span>
          <div>
            <h2 id="pos-answer-title">What does Internext POS do?</h2>
            <p>
              It records what you sell, how the customer paid, what stock changed and what the cash
              drawer should contain at closing. Restaurant teams can also manage tables, open orders
              and kitchen dispatch in the released online workflow.
            </p>
          </div>
          <div>
            <h3>Who is it for?</h3>
            <p>
              Restaurants and cafés can use the online pilot. Grocery, convenience, pet-shop and
              retail counters can request a configured demo and workflow review.
            </p>
          </div>
        </section>
        <section id="workflow" className="ip-workflow" aria-labelledby="workflow-title">
          <div className="ip-wrap">
            <div className="ip-section-heading">
              <h2 id="workflow-title">A workspace that follows your shift.</h2>
              <p>From the next customer to the closing count.</p>
            </div>
            <ol className="ip-steps">
              {steps.map(({ icon: Icon, title, text }, index) => (
                <li key={title}>
                  <div className="ip-step-top">
                    <Icon size={26} strokeWidth={1.6} aria-hidden="true" />
                    <span>Step {index + 1}</span>
                  </div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
        <section className="ip-industries ip-wrap" aria-labelledby="industries-title">
          <div className="ip-section-heading">
            <h2 id="industries-title">See your kind of counter.</h2>
            <p>
              Restaurant workflows are available online. Retail samples are demo configurations;
              service and wholesale workflows need review before launch.
            </p>
          </div>
          <div className="ip-industry-grid">
            {industryPreviews.map((item) => (
              <figure key={item.image} className="ip-industry-card">
                <a
                  href={`/product-previews/${item.image}.webp`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open a larger ${item.title} sample interface`}
                >
                  <img
                    src={`/product-previews/${item.image}.webp`}
                    alt={`Sample Internext POS checkout for ${item.title}, with an industry catalogue, current order and checkout controls`}
                    width={800}
                    height={520}
                    loading="lazy"
                    decoding="async"
                  />
                </a>
                <figcaption>
                  <div>
                    <h3>{item.title}</h3>
                    <em>{item.status}</em>
                  </div>
                  <span>{item.text}</span>
                  <small>Open full-size preview (new tab).</small>
                </figcaption>
              </figure>
            ))}
          </div>
          <p className="ip-industry-boundary">
            Medical and pharmacy use needs a suitability review. Batch, expiry and
            regulated-medicine controls are not currently presented as released features.
          </p>
        </section>
        <section id="features" className="ip-availability ip-wrap" aria-labelledby="features-title">
          <div className="ip-availability-copy">
            <span className="ip-small-icon">
              <ShieldCheck size={24} aria-hidden="true" />
            </span>
            <h2 id="features-title">
              Know what’s ready.
              <br />
              See what’s next.
            </h2>
            <p>
              The online pilot handles connected counter sales. A separate training workspace lets
              your team explore more of the restaurant workflow.
            </p>
            <Link href="/pos" className="ip-inline-link">
              Open the training workspace <ArrowRight size={17} aria-hidden="true" />
            </Link>
            <div className="ip-connection-note">
              <WifiOff size={19} aria-hidden="true" />
              <p>
                Live sales currently require internet. Offline live billing and the Android APK are
                not released yet.
              </p>
            </div>
          </div>
          <div className="ip-availability-list">
            {availability.map((item) => (
              <article key={item.title}>
                <div className="ip-feature-title">
                  <h3>{item.title}</h3>
                  <span className={`ip-status ${item.ready ? 'ip-status-ready' : ''}`}>
                    {item.ready && <Check size={12} aria-hidden="true" />}
                    {item.status}
                  </span>
                </div>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="ip-roadmap ip-wrap" aria-labelledby="roadmap-title">
          <div className="ip-section-heading">
            <h2 id="roadmap-title">
              Room for your next idea.
              <br />
              And your next branch.
            </h2>
            <p>
              Offers are available in the online pilot. Android and subscriptions follow as each
              feature is released.
            </p>
          </div>
          <div className="ip-roadmap-grid">
            <article className="ip-offer-card">
              <div className="ip-roadmap-top">
                <Tag size={27} strokeWidth={1.6} aria-hidden="true" />
                <span>Online pilot</span>
              </div>
              <h3>Offers with clear rules.</h3>
              <p>
                Give your team a consistent way to apply restaurant offers, with clear eligibility
                and an understandable discount on the bill.
              </p>
              <div className="ip-offer-example">
                <span>
                  <Tag size={17} aria-hidden="true" /> Offer controls
                </span>
                <div>
                  <span>Which items?</span>
                  <span>When is it available?</span>
                  <span>Who can apply it?</span>
                </div>
                <small>Choose eligible items, schedules and staff permissions</small>
              </div>
            </article>
            <div className="ip-roadmap-stack">
              <article>
                <Smartphone size={27} strokeWidth={1.6} aria-hidden="true" />
                <div>
                  <span className="ip-plan-label">Planned</span>
                  <h3>Android, with offline service.</h3>
                  <p>
                    A dedicated APK for the POS device, local order storage and visible
                    synchronisation when connectivity returns.
                  </p>
                </div>
              </article>
              <article>
                <Store size={27} strokeWidth={1.6} aria-hidden="true" />
                <div>
                  <span className="ip-plan-label">Expanding after the pilot</span>
                  <h3>A view across your branches.</h3>
                  <p>
                    Build on branch access with wider reporting and management tools as the product
                    grows.
                  </p>
                </div>
              </article>
            </div>
          </div>
        </section>
        <section id="pricing" className="ip-pricing ip-wrap" aria-labelledby="pricing-title">
          <div className="ip-pricing-copy">
            <h2 id="pricing-title">
              One branch.
              <br />
              One complete plan.
            </h2>
            <p>
              Start with the branch you have today. Add another when you’re ready. The plan includes
              multiple staff and devices, plus the product features currently released.
            </p>
            <ul>
              <li>
                <Check size={18} aria-hidden="true" /> Online counter and staff access
              </li>
              <li>
                <Check size={18} aria-hidden="true" /> Multiple devices per branch
              </li>
              <li>
                <Check size={18} aria-hidden="true" /> Planned features included as released
              </li>
            </ul>
            <div className="ip-billing-note">
              <CreditCard size={21} aria-hidden="true" />
              <p>
                <strong>Manual branch subscription collection.</strong>
                <br />
                Subscription checkout is not enabled yet.
              </p>
            </div>
          </div>
          <div className="ip-price-panel">
            <div className="ip-price-heading">
              <span>Internext POS</span>
              <Store size={25} strokeWidth={1.5} aria-hidden="true" />
            </div>
            <div className="ip-price">
              <span>US$</span>
              <strong>100</strong>
            </div>
            <p>per branch, per month</p>
            <div className="ip-price-included">
              <Monitor size={19} aria-hidden="true" />
              <span>
                Your branch. Multiple devices.
                <br />
                Released online POS features.
              </span>
            </div>
            <a
              href="https://wa.me/971557133786?text=Hi%20Internext%2C%20I%27d%20like%20to%20book%20a%20Smart%20AI%20POS%20demo%20for%20US%24100%20per%20branch%20per%20month."
              className="ip-button ip-button-light"
            >
              Book a live demo <ArrowRight size={18} aria-hidden="true" />
            </a>
            <Link href="/pos" className="ip-price-training">
              Explore the training workspace first
            </Link>
            <small>
              Software subscription. POS hardware is separate. Checkout and final billing details
              will be shown before any payment.
            </small>
          </div>
        </section>
        <section className="ip-pilot ip-wrap">
          <Store size={25} strokeWidth={1.6} aria-hidden="true" />
          <div>
            <h2>Built around a real restaurant counter.</h2>
            <p>
              Our first pilot is for Abdul Gafoor Suleman Usman Mithaiwala Restaurant LLC, Bur
              Dubai. The menu photography shown here comes from the restaurant’s existing menu
              library.
            </p>
          </div>
        </section>
        <section className="ip-faq ip-wrap" aria-labelledby="faq-title" id="faq">
          <div>
            <CircleHelp size={22} aria-hidden="true" />
            <h2 id="faq-title">POS software questions</h2>
          </div>
          {faqItems.map((item) => (
            <details key={item.question}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </section>
      </main>
      <footer className="ip-footer ip-wrap">
        <Wordmark />
        <p>
          Dubai POS software by{' '}
          <a href="https://internext.info/">Internext Information Technology</a>.
        </p>
        <nav aria-label="Footer navigation">
          <Link href="/counter">Staff sign in</Link>
          <Link href="/pos">Training</Link>
          <Link href="/billing">Subscriptions</Link>
        </nav>
      </footer>
    </div>
  )
}
