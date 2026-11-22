/**
 * The buyer's cart on one business's site: the variants and quantities chosen,
 * kept in a first-party cookie so it survives reloads and server rendering.
 * Prices, stock and shipping are never stored here; the cart is priced by the
 * server each time it is shown.
 */
export interface CartLine { product_variant_id: string; quantity: number }

// A browser keeps a cookie of at most 4 KB, name included; the oldest lines give way to stay under it.
const MAX_BYTES = 3500

export function useCart(organizationId: string) {
  const cookie = useCookie<CartLine[]>(`cart_${organizationId}`, { default: () => [], sameSite: 'lax', maxAge: 60 * 60 * 24 * 30, path: '/' })
  // One cart per page, read from the cookie once: the header, buy box and cart page all see the same lines as they change.
  const state = useState<CartLine[]>(`cart:${organizationId}`, () => Array.isArray(cookie.value) ? cookie.value : [])
  const lines = computed(() => state.value.filter(line => typeof line?.product_variant_id === 'string' && Number.isSafeInteger(line.quantity) && line.quantity > 0))
  const count = computed(() => lines.value.reduce((sum, line) => sum + line.quantity, 0))
  function write(next: CartLine[]) {
    while (next.length > 1 && encodeURIComponent(JSON.stringify(next)).length > MAX_BYTES) next.shift()
    state.value = next
    cookie.value = next
  }
  function set(productVariantId: string, quantity: number) {
    const capped = Math.min(quantity, 99)
    const existing = lines.value.some(line => line.product_variant_id === productVariantId)
    // A line keeps its place when its quantity changes; a new one joins the end.
    write(quantity <= 0 ? lines.value.filter(line => line.product_variant_id !== productVariantId)
      : existing ? lines.value.map(line => line.product_variant_id === productVariantId ? { ...line, quantity: capped } : line)
        : [...lines.value, { product_variant_id: productVariantId, quantity: capped }])
  }
  function add(productVariantId: string, quantity = 1) {
    set(productVariantId, (lines.value.find(line => line.product_variant_id === productVariantId)?.quantity ?? 0) + quantity)
  }
  function clear() { write([]) }
  return { lines, count, set, add, clear }
}
