export function getOrCreateShopId(): string {
  let shopId = localStorage.getItem('printflow_shop_id');
  if (!shopId) {
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    shopId = `shop_${randomSuffix}`;
    localStorage.setItem('printflow_shop_id', shopId);
  }
  return shopId;
}

export function resetShopWorkspace(): void {
  localStorage.removeItem('printflow_shop_id');
}