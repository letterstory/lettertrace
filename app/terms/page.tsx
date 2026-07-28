import type { Metadata } from "next";
import { LegalPage, Section } from "@/components/legal";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms governing use of the hosted Lettertrace service, operated by The Letter Company.",
};

const UPDATED = "July 27, 2026";

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated={UPDATED}
      intro="These terms govern your use of the hosted Lettertrace service at lettertrace.com, operated by The Letter Company. Lettertrace's source code is separately available under the MIT licence; these terms apply to the service we run, not to the code."
    >
      <Section n={1} title="Agreement">
        <p>By creating an account or using Lettertrace, you agree to these terms. If you are using it on behalf of a company, you confirm you have authority to bind that company, and &quot;you&quot; means that company. If you do not agree, do not use the service.</p>
      </Section>

      <Section n={2} title="What Lettertrace does">
        <p>Lettertrace sends questions you configure to AI assistants such as Claude and ChatGPT, records their answers, and reports how often your brand and your competitors are named, in what tone, and how prominently. It is a measurement tool. It does not influence what those models say.</p>
      </Section>

      <Section n={3} title="Accounts">
        <p>You are responsible for the accuracy of your account information, for keeping your credentials secure, and for everything that happens under your account. Tell us promptly if you believe your account or an API key has been compromised. One person or organisation per account; do not share credentials.</p>
      </Section>

      <Section n={4} title="Your provider keys and costs">
        <p>Lettertrace is bring-your-own-key. When you add an Anthropic or OpenAI key, runs execute against your own account with that provider.</p>
        <ul>
          <li><strong>You pay those providers directly.</strong> We do not mark up, resell, or reimburse provider usage, and we are not responsible for charges you incur. Monitoring runs consume tokens every time they execute, including on a schedule.</li>
          <li><strong>You must comply with your provider&apos;s terms.</strong> Using Lettertrace does not exempt you from them.</li>
          <li><strong>You are responsible for your own spending controls.</strong> Set limits with your provider. Settings such as the number of prompts, the model, replicate count, and web search all change how much a run costs, and a scheduled run repeats that cost on its own.</li>
        </ul>
        <p>Where we offer trial runs on our shared provider keys, those are a limited courtesy, subject to a run cap, and may be changed or withdrawn at any time.</p>
      </Section>

      <Section n={5} title="Your content">
        <p>You keep ownership of everything you put into Lettertrace — your brand configuration, topics, prompts, and competitor lists — and of the reports generated from your runs. You grant us a limited licence to store, process, and transmit that content as needed to operate the service for you.</p>
        <p>You are responsible for having the right to monitor the brands and domains you configure.</p>
      </Section>

      <Section n={6} title="Accuracy of measurements">
        <p>Please read this section carefully; it describes a real limitation of the product rather than boilerplate.</p>
        <p><strong>AI models are not deterministic.</strong> The same prompt sent to the same model can return a different answer each time. A brand named in one run may be absent from the next with no underlying change in the world. Lettertrace reports mention rates with confidence intervals for exactly this reason, and those intervals should be read, not ignored.</p>
        <p><strong>Results are estimates from a sample</strong>, not a complete census of what AI assistants say. A run measures the prompts you configured, at one moment, on the models you selected. Different prompts produce very different results.</p>
        <p><strong>Detection and classification can be wrong.</strong> Brand matching is literal text matching and may miss unusual phrasings or match coincidental ones. Sentiment and recommendation labels are produced by a model and may be inaccurate.</p>
        <p>Lettertrace is provided as an input to your judgement, not a substitute for it. Do not rely on it as the sole basis for a commercial, financial, or legal decision.</p>
      </Section>

      <Section n={7} title="Acceptable use">
        <p>Do not:</p>
        <ul>
          <li>Use Lettertrace to break the law, or to infringe anyone&apos;s rights.</li>
          <li>Attempt to access another user&apos;s account or data.</li>
          <li>Probe, scan, overload, or otherwise interfere with the service or its infrastructure.</li>
          <li>Use it to generate spam, harassment, or deliberately misleading material about a person or company.</li>
          <li>Circumvent trial limits, rate limits, or other technical restrictions.</li>
          <li>Configure prompts intended to extract personal data about individuals.</li>
        </ul>
      </Section>

      <Section n={8} title="Programmatic access">
        <p>Lettertrace offers a REST API and an MCP server, authenticated with Lettertrace API keys. Keep those keys secret; anyone holding one can read your data and trigger runs that spend your provider credits. Revoke a key immediately if it may have leaked. We may apply rate limits, and may suspend a key that is degrading the service for others.</p>
      </Section>

      <Section n={9} title="Third-party services">
        <p>Lettertrace depends on Anthropic, OpenAI, Supabase, Vercel, and — if you use social sign-in — Google and GitHub. We do not control those services. Outages, changes, price increases, or policy changes on their side may affect or interrupt Lettertrace, and we are not liable for them.</p>
      </Section>

      <Section n={10} title="Open source and self-hosting">
        <p>Lettertrace&apos;s source is released under the MIT licence, and you are free to run your own instance under that licence. These terms govern only the hosted service we operate. We provide no warranty or support for self-hosted deployments, and we are not responsible for how they behave.</p>
      </Section>

      <Section n={11} title="Availability and changes">
        <p>We aim to keep Lettertrace available but offer no uptime guarantee. We may modify, suspend, or discontinue features at any time. Scheduled runs may be delayed or skipped during maintenance or provider outages.</p>
      </Section>

      <Section n={12} title="Fees">
        <p>The hosted service is currently offered free of charge. If we introduce paid plans we will give notice before charging you, and you will be free to stop using the service instead. Charges from AI providers under your own keys are separate and always your responsibility (§4).</p>
      </Section>

      <Section n={13} title="Disclaimer of warranties">
        <p>Lettertrace is provided &quot;as is&quot; and &quot;as available&quot;, without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that the service will be uninterrupted, error-free, or that its measurements will be accurate or complete.</p>
      </Section>

      <Section n={14} title="Limitation of liability">
        <p>To the maximum extent permitted by law, The Letter Company is not liable for any indirect, incidental, special, consequential, or punitive damages, or for lost profits, lost revenue, lost data, or business interruption, arising from your use of Lettertrace.</p>
        <p>This includes charges you incur with AI providers, and decisions made on the basis of measurements the service reports.</p>
        <p>Our total liability for any claim relating to the service is limited to the greater of the amount you paid us for it in the twelve months before the claim, or one hundred US dollars.</p>
        <p>Some jurisdictions do not allow certain limitations, in which case the above apply to the fullest extent permitted.</p>
      </Section>

      <Section n={15} title="Indemnification">
        <p>You agree to indemnify The Letter Company against claims, losses, and reasonable legal costs arising from your use of the service, your content, or your breach of these terms.</p>
      </Section>

      <Section n={16} title="Termination">
        <p>You may delete your account at any time. We may suspend or terminate access if you breach these terms, or if we reasonably believe your use puts the service or other users at risk. On termination your right to use the service ends immediately and your data is deleted in accordance with our <a href="/privacy">Privacy Policy</a>. Export anything you want to keep beforehand.</p>
      </Section>

      <Section n={17} title="Changes to these terms">
        <p>We may update these terms as the service changes. We will update the date at the top, and for material changes we will make a reasonable effort to notify you. Continuing to use Lettertrace after an update means you accept the revised terms.</p>
      </Section>

      <Section n={18} title="Contact">
        <p>
          Questions about these terms:{" "}
          <a href="mailto:support@letterbrace.com">support@letterbrace.com</a>
        </p>
      </Section>
    </LegalPage>
  );
}
