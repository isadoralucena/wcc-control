# WCC Control

Sistema web para organizar competições de programação: configura participantes, distribui equipes nos laboratórios do LCC/UFCG, acompanha o VJudge e controla a entrega de balões.

## Funcionalidades

1. **Configuração:** dados da competição, laboratórios, participantes, usernames do VJudge e modalidade individual ou em equipe.
2. **Mapa de sala:** distribuição automática nas bancadas, respeitando a planta do LCC, disponibilidade dos computadores e espaçamento. Também permite ajustes manuais.
3. **VJudge:** configuração do contest e do gateway, importação de questões e atualização automática das submissões.
4. **Arena:** acompanhamento de participantes e questões, fila de balões, notificações e estatísticas.

## Integrações

### LCC/UFCG

O sistema consulta `https://lcc.ufcg.edu.br/` pelo WCC Gateway, pois o site não oferece API nem permite consultas diretas pelo navegador (CORS).

A planta dos laboratórios é obtida automaticamente e também possui um snapshot de contingência, atualizado no deploy. **Cada computador representa uma cadeira.** Em equipes, os participantes ocupam cadeiras vizinhas, mas utilizam o computador central.

### VJudge

O VJudge também é consultado pelo WCC Gateway, responsável por contornar a restrição de CORS e centralizar o acesso ao contest. O VJudge não tem API oficial; o gateway usa os mesmos endpoints internos do site.

Para contests privados, o gateway faz login sozinho com uma conta da organização (secrets `VJUDGE_USERNAME` e `VJUDGE_ACCOUNT_PASSWORD`), guarda a sessão no Workers KV e a renova quando expira — não é preciso copiar cookies. Se a conta for gerente do contest, a senha do contest é dispensada; caso contrário, o organizador a informa uma vez na tela **VJudge**. Se o VJudge exigir verificação humana no login, o gateway não a contorna: o aviso aparece no app e a importação por JSON continua disponível.

A sincronização ocorre automaticamente, sem remover resultados já registrados ou alterar entregas de balões. Se a integração falhar, é possível importar o ranking por JSON e registrar Accepted manualmente.

## Arquitetura

- **Frontend:** React + Vite + TypeScript, publicado no GitHub Pages.
- **Gateway:** Cloudflare Worker, responsável pelas consultas ao LCC e ao VJudge.
- **Persistência:** LocalStorage do navegador, com opção de exportar e importar os dados em JSON.

Os dados da competição ficam no navegador utilizado. Para trabalhar simultaneamente em vários dispositivos, será necessário adicionar um backend compartilhado.

## Desenvolvimento

```bash
npm install
npm run dev
npm test
npm run build
```

Comandos adicionais:

```bash
npm run lcc:snapshot
npm run gateway:bundle
npm run gateway:dev
```

## Publicação

### Aplicação

1. Envie o projeto para o GitHub.
2. Em **Settings → Pages**, selecione **GitHub Actions** como fonte de publicação.
3. O workflow de deploy executa os testes, gera o build e publica a aplicação.

### WCC Gateway

1. Crie um Worker em **Cloudflare → Workers & Pages**.
2. Publique o conteúdo de `gateway/dist/wcc-gateway.js`.
3. Configure a URL do Worker nas variáveis do GitHub Actions.
4. Para contests privados: crie o KV `WCC_KV`, os secrets `VJUDGE_USERNAME` e `VJUDGE_ACCOUNT_PASSWORD` e a variável `ALLOWED_ORIGINS` com a URL do GitHub Pages.
5. Na aplicação, acesse **VJudge → Testar conexão** para verificar a integração.

Consulte [`gateway/README.md`](gateway/README.md) para as instruções detalhadas de configuração do gateway.

## Estrutura

```text
src/
  domain/       regras de negócio e alocação
  services/     comunicação com o gateway
  state/        estado e persistência
  data/         snapshot dos laboratórios
  components/   componentes reutilizáveis
  screens/      telas da aplicação
gateway/        WCC Gateway
scripts/        scripts auxiliares
```