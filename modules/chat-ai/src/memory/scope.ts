export type ConversationScope =
  | { readonly type: 'private'; readonly platform: string; readonly userId: string }
  | { readonly type: 'group'; readonly platform: string; readonly groupId: string }

export const privateScope = (platform: string, userId: string): ConversationScope => ({
  type: 'private',
  platform,
  userId
})

export const groupScope = (platform: string, groupId: string): ConversationScope => ({
  type: 'group',
  platform,
  groupId
})

export const formatScopeKey = (scope: ConversationScope): string =>
  scope.type === 'group' ? `${scope.platform}:group:${scope.groupId}` : `${scope.platform}:private:${scope.userId}`

export const parseScopeKey = (scopeKey: string): ConversationScope => {
  const [platform = '', type = 'private', id = ''] = scopeKey.split(':')
  return type === 'group' ? groupScope(platform, id) : privateScope(platform, id)
}
