// Keep HTTP status and Discord's numeric reason separate; never echo request bodies.
function discordRestError(status, detail, path, method) {
  const discordCode = Number.isInteger(detail?.code) ? detail.code : undefined;
  const sending = method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(path);
  const members = /^\/guilds\/[^/]+\/members/.test(path);
  const reasons = {
    10003: 'Canal não encontrado. Atualize os canais e selecione o destino novamente.',
    10007: 'Esta pessoa não foi encontrada no servidor selecionado.',
    50001: 'A conta conectada não tem acesso a este canal ou servidor. Confira se ela está no servidor e pode Ver canal.',
    50007: 'O Discord não permite enviar mensagens privadas para esta pessoa.',
    50008: 'Este canal não aceita mensagens de texto. Escolha um canal de texto.',
    50009: 'A conta não atende à verificação exigida pelo servidor. Confira o aviso no aplicativo oficial.',
    50013: sending
      ? 'Falta permissão para enviar neste canal. Confira Ver canal e Enviar mensagens para a conta conectada, incluindo as permissões do canal e da categoria.'
      : 'Falta permissão para esta operação no servidor selecionado.',
    50083: 'Esta conversa está arquivada. Escolha um canal ou uma conversa ativa.',
    200000: 'O AutoMod do servidor bloqueou esta mensagem. Revise o texto conforme as regras do servidor.'
  };
  let reason = reasons[discordCode];
  if (Array.isArray(detail?.captcha_key) || detail?.captcha_sitekey) reason = 'O Discord exige uma verificação da conta. Resolva o aviso ou CAPTCHA no aplicativo oficial antes de tentar enviar novamente.';
  if (!reason && status === 403) reason = sending
    ? 'O Discord recusou o envio. Use Verificar permissões no painel para conferir a conta, o canal e possíveis restrições.'
    : 'O Discord recusou o acesso a esta operação. Confira a conta conectada e suas permissões.';
  if (members && status === 403) reason += ' Para carregar a lista completa com bot oficial, confira Server Members Intent em Developer Portal → Bot.';
  if (!reason) reason = status === 404 ? 'Recurso não encontrado ou indisponível para a conta conectada.' : 'O Discord não concluiu a operação.';
  const channelId = /^\/channels\/([^/]+)/.exec(path)?.[1];
  return Object.assign(new Error(`${reason} (HTTP ${status}${discordCode ? ` · Discord ${discordCode}` : ''}${sending ? ` · canal ${channelId}` : ''})`), {
    code: status, discordCode, channelId
  });
}

module.exports = { discordRestError };
