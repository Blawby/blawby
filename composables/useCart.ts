/**
 * The buyer's cart on one business's site: the variants and quantities chosen,
 * kept in a first-party cookie so it survives reloads and server rendering.
 * Prices, stock and shipping are never stored here; the cart is priced by the
 * server each time it is shown.
 */
export interface CartLine { product_variant_id: string; quantity: number }

const MAX_LINES = 50

export function useCart(organizationId: string) {
  const cookie = useCookie<CartLine[]>(`cart_${organizationId}`, { default: () => [], sameSite: 'lax', maxAge: 60 * 60 * 24 * 30, path: '/' })
  const lines = computed(() => (Array.isArray(cookie.value) ? cookie.value : []).filter(line => typeof line?.product_variant_id === 'string' && Number.isSafeInteger(line.quantity) && line.quantity > 0))
  const count = computed(() => lines.value.reduce((sum, line) => sum + line.quantity, 0))
  function set(productVariantId: string, quantity: number) {
    const rest = lines.value.filter(line => line.product_variant_id !== productVariantId)
    cookie.value = quantity > 0 ? [...rest, { product_variant_id: productVariantId, quantity: Math.min(quantity, 99) }].slice(-MAX_LINES) : rest
  }
  function add(productVariantId: string, quantity = 1) {
    set(productVariantId, (lines.value.find(line => line.product_variant_id === productVariantId)?.quantity ?? 0) + quantity)
  }
  function clear() { cookie.value = [] }
  return { lines, count, set, add, clear }
}
