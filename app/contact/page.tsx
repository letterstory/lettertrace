import type { Metadata } from "next";
import { LegalPage, Section } from "@/components/legal";
import {
  FOUNDER_CALL_LANDING_SOURCE,
  founderCallUrl,
  taggedBookingUrl,
} from "@/lib/founder-call";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "Book a demo of Lettertrace or get in touch with The Letter Company, the team behind it.",
};

const UPDATED = "November 26, 2026";
const GITHUB_URL = "https://github.com/letterstory/lettertrace";
const SUPPORT_EMAIL = "support@letterbrace.com";

export default function ContactPage() {
  const bookingUrl = founderCallUrl();

  return (
    <LegalPage
      title="Contact"
      updated={UPDATED}
      intro="Lettertrace is operated by The Letter Company. Want a walkthrough, or have a question? Here's how to reach us."
    >
      <Section n={1} title="Book a demo">
        {bookingUrl ? (
          <>
            <p>
              Grab 15 minutes with Mathew, our founder. He&apos;ll walk you through setting up
              your brand and topics, and how to read your first results.
            </p>
            <p>
              <a
                href={taggedBookingUrl(bookingUrl, FOUNDER_CALL_LANDING_SOURCE)}
                target="_blank"
                rel="noreferrer"
              >
                Pick a time
              </a>
            </p>
          </>
        ) : (
          <p>
            Email <a href={`mailto:${SUPPORT_EMAIL}?subject=Lettertrace%20demo`}>{SUPPORT_EMAIL}</a>{" "}
            and tell us what you&apos;d like to see. We&apos;ll walk you through setting up your
            brand and topics, and how to read your first results.
          </p>
        )}
      </Section>

      <Section n={2} title="Questions and support">
        <p>
          For anything about your account, your monitors, or these pages:{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>
      </Section>

      <Section n={3} title="Bugs and feature requests">
        <p>
          Lettertrace is open source. If you&apos;ve found a bug or want something added, open an
          issue on <a href={GITHUB_URL}>GitHub</a>.
        </p>
      </Section>
    </LegalPage>
  );
}
