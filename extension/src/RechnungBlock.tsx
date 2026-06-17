import {
  reactExtension,
  useApi,
  Card,
  BlockStack,
  Heading,
  Button,
  Text,
  Spinner,
  Banner,
} from "@shopify/ui-extensions-react/customer-account";
import { useEffect, useState } from "react";

/**
 * The "Rechnung" card on the order detail page.
 *
 * It asks our backend proxy for every invoice document tied to this order
 * (main invoice + any credit notes / Gutschriften) and renders one download
 * button per document. The Pathway API key lives only on the backend.
 *
 * Set the backend URL below (or via the BACKEND_URL constant) to your deployed
 * proxy, e.g. https://pathway-invoice-proxy.up.railway.app
 */
const BACKEND_URL = "https://vf-invoice-download-production.up.railway.app";

type Invoice = { id: string; label: string; type: string; downloadUrl: string };

export default reactExtension(
  "customer-account.order-status.block.render",
  () => <RechnungCard />,
);

function RechnungCard() {
  const { order, sessionToken } = useApi<"customer-account.order-status.block.render">();

  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; invoices: Invoice[] }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Fetch a fresh session token immediately before the request.
        const token = await sessionToken.get();
        const res = await fetch(
          `${BACKEND_URL}/invoices?orderId=${encodeURIComponent(order.id)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) throw new Error(`backend ${res.status}`);
        const invoices = (await res.json()) as Invoice[];
        if (!cancelled) setState({ status: "ready", invoices });
      } catch (e) {
        if (!cancelled) setState({ status: "error" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [order.id, sessionToken]);

  return (
    <Card padding>
      <BlockStack spacing="base">
        <Heading level={2}>Rechnung</Heading>

        {state.status === "loading" && <Spinner accessibilityLabel="Rechnungen werden geladen" />}

        {state.status === "error" && (
          <Banner status="critical">
            Rechnungen konnten nicht geladen werden. Bitte versuche es später erneut.
          </Banner>
        )}

        {state.status === "ready" && state.invoices.length === 0 && (
          <Text appearance="subdued">Für diese Bestellung ist noch keine Rechnung verfügbar.</Text>
        )}

        {state.status === "ready" &&
          state.invoices.map((inv) => (
            <Button key={inv.id} to={inv.downloadUrl} kind="secondary">
              {inv.label} herunterladen
            </Button>
          ))}
      </BlockStack>
    </Card>
  );
}
