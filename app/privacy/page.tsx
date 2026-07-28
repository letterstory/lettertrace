import type { Metadata } from "next";
import { LegalPage, Section } from "@/components/legal";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Lettertrace collects, uses, and protects your data, including your bring-your-own-key provider credentials.",
};

const UPDATED = "July 27, 2026";

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated={UPDATED}
      intro="Lettertrace is operated by The Letter Company. This policy explains what we collect when you use the hosted service at lettertrace.com, why we collect it, and who else sees it."
    >
      <Section n={1} title="Information we collect">
        <p><strong>Account information.</strong> Your email address, and — if you sign in with Google or GitHub — the name and profile picture that provider returns. We never receive your Google or GitHub password.</p>
        <p><strong>Monitoring configuration.</strong> The brands, domains, aliases, competitors, topics, and prompts you set up, plus your model and schedule preferences.</p>
        <p><strong>Run results.</strong> For each monitoring run we store the full text of the answers the AI models returned, the web sources they cited, and the brand and competitor mentions detected in them, along with sentiment and position.</p>
        <p><strong>Provider API keys.</strong> If you bring your own Anthropic or OpenAI key, we store it encrypted (see §5) so scheduled runs can use it. We also store a short hint such as <code>sk-…4a9c</code> so you can tell your keys apart.</p>
        <p><strong>Lettertrace API keys.</strong> Stored only as SHA-256 hashes. The full key is shown once at creation and cannot be recovered by us or by you afterwards.</p>
        <p><strong>Usage counters.</strong> If you use trial runs on our shared provider keys, we count the runs and tokens consumed so we can apply the free-run limit.</p>
        <p>We do not use advertising trackers, and we do not build behavioural profiles of you.</p>
      </Section>

      <Section n={2} title="What we send to AI providers">
        <p>This is the part most worth understanding, because it is the core of what Lettertrace does.</p>
        <p>When a monitoring run executes, we send your prompts to Anthropic and/or OpenAI. If web search is enabled for a project, those providers also run search queries derived from your prompts. The answers come back to us and are stored against your account.</p>
        <p><strong>Under bring-your-own-key, those requests are made with your API key, under your own account with that provider.</strong> How they handle, retain, and train on that traffic is governed by your agreement with them, not by this policy. Review Anthropic&apos;s and OpenAI&apos;s privacy terms directly.</p>
        <p>If you instead use trial runs on our shared keys, those requests are made under The Letter Company&apos;s provider accounts and are subject to our agreements with those providers.</p>
        <p>Prompts are questions about a market or category. Do not put personal data, customer information, or confidential material into a prompt — it will be transmitted to a third-party model provider.</p>
      </Section>

      <Section n={3} title="Website content we fetch">
        <p>During onboarding you can give us a brand&apos;s domain, and we fetch that site&apos;s public homepage to suggest topics and prompts. We fetch only publicly reachable pages over HTTP(S), and we block requests to private and internal network addresses. We store the extracted text only long enough to generate suggestions.</p>
      </Section>

      <Section n={4} title="How we use your information">
        <ul>
          <li>To operate the service: run monitors, detect mentions, and show your results.</li>
          <li>To authenticate you and keep your account secure.</li>
          <li>To enforce free-trial limits, where you use our shared provider keys.</li>
          <li>To respond to support requests you send us.</li>
          <li>To diagnose faults and keep the service running.</li>
        </ul>
        <p>We do not sell your personal information, and we do not share it for advertising.</p>
      </Section>

      <Section n={5} title="Security">
        <p><strong>Provider API keys are encrypted at rest using AES-256-GCM</strong> with a unique initialization vector per key. They are decrypted only in memory, at the moment a run executes.</p>
        <p><strong>Lettertrace API keys are stored as SHA-256 hashes only</strong> — never in plaintext.</p>
        <p><strong>Your data is isolated per account by Postgres Row Level Security</strong>, enforced by the database rather than only by application code. Elevated database access is limited to the scheduled-run job and the API-key-authenticated surface, where every query is scoped to the key&apos;s owner.</p>
        <p>Traffic to and from lettertrace.com is encrypted in transit over TLS. No system is perfectly secure, and we cannot guarantee absolute security.</p>
      </Section>

      <Section n={6} title="Service providers">
        <p>We rely on the following processors to run Lettertrace:</p>
        <ul>
          <li><strong>Supabase</strong> — database, authentication, and storage of everything described in §1.</li>
          <li><strong>Vercel</strong> — application hosting and request logs.</li>
          <li><strong>Anthropic</strong> and <strong>OpenAI</strong> — the AI models queried during runs, as described in §2.</li>
          <li><strong>Google</strong> and <strong>GitHub</strong> — optional sign-in. They tell us your email, name, and profile picture; we tell them nothing about your usage.</li>
        </ul>
        <p>We may also disclose information where legally required, or to protect the rights and safety of our users or the service.</p>
      </Section>

      <Section n={7} title="Data retention">
        <p>Your configuration and run history are retained for as long as your account is active, because the product&apos;s value is the trend over time — deleting old runs would erase the record of how your visibility changed.</p>
        <p>When you delete a project, its topics, prompts, competitors, runs, responses, sources, and mentions are deleted with it. When your account is deleted, everything associated with it is deleted.</p>
        <p>Deleting a provider API key removes the encrypted value immediately. Revoking a Lettertrace API key takes effect immediately.</p>
      </Section>

      <Section n={8} title="Your rights">
        <p>You can, at any time:</p>
        <ul>
          <li>Access and correct your account and project information in the dashboard.</li>
          <li>Delete individual projects, prompts, competitors, or provider keys.</li>
          <li>Revoke Lettertrace API keys.</li>
          <li>Request a copy of your data, or deletion of your account, by emailing us.</li>
        </ul>
        <p>Depending on where you live, you may have additional rights under the GDPR, the UK GDPR, or the CCPA — including access, correction, deletion, portability, and objecting to certain processing. We honour these requests regardless of where you are. We do not sell personal information as defined by the CCPA.</p>
      </Section>

      <Section n={9} title="Cookies">
        <p>We use cookies only for authentication — keeping you signed in and refreshing your session. We do not use advertising or cross-site tracking cookies. Clearing them signs you out.</p>
      </Section>

      <Section n={10} title="Children">
        <p>Lettertrace is a business tool and is not directed at children under 16. We do not knowingly collect information from them. If you believe a child has given us information, email us and we will delete it.</p>
      </Section>

      <Section n={11} title="International transfers">
        <p>The Letter Company operates in the United States, and our service providers process data in the United States and other countries. Using Lettertrace means your information may be transferred to and processed in those countries.</p>
      </Section>

      <Section n={12} title="Scope of this policy">
        <p>This policy covers the hosted Lettertrace service that we operate at lettertrace.com. It does not cover any separately operated deployment of the software, where we would neither hold nor receive the data.</p>
      </Section>

      <Section n={13} title="Changes to this policy">
        <p>We may update this policy as the service changes. We will update the date at the top, and for material changes we will make a reasonable effort to notify you. Continuing to use Lettertrace after an update means you accept the revised policy.</p>
      </Section>

      <Section n={14} title="Contact">
        <p>
          Questions about this policy, or requests about your data:{" "}
          <a href="mailto:privacy@letterbrace.com">privacy@letterbrace.com</a>
        </p>
      </Section>
    </LegalPage>
  );
}
