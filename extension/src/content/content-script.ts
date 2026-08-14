import { AssistantUi } from './assistant-ui.js';
import type { AssistantUiState, ConversationState, ExtensionPreferences } from '../shared/types.js';

let preferences:Partial<ExtensionPreferences>={selectionModeEnabled:true,autoSubmitSelection:false};
const ui=new AssistantUi((text,messageId)=>void chrome.runtime.sendMessage({type:'NEOTALK_SUBMIT_PHRASE',frase:text,source:'manual',messageId}),mode=>{if(mode==='tab-audio')void chrome.runtime.sendMessage({type:'NEOTALK_START_TAB_AUDIO'})},()=>void chrome.runtime.sendMessage({type:'NEOTALK_CLEAR_CONVERSATION'}));
void chrome.storage.local.get(['neotalkConversation','neotalkAssistantUi']).then(result=>{if(result.neotalkConversation)ui.render(result.neotalkConversation as ConversationState);if(result.neotalkAssistantUi)ui.restore(result.neotalkAssistantUi as AssistantUiState)});
void chrome.storage.sync.get('neotalkPreferences').then(result=>preferences=(result.neotalkPreferences as Partial<ExtensionPreferences>)??preferences);
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.neotalkConversation)ui.render(changes.neotalkConversation.newValue as ConversationState);if(area==='sync'&&changes.neotalkPreferences)preferences=changes.neotalkPreferences.newValue as Partial<ExtensionPreferences>});
function editable(node:Node|null){const element=node instanceof Element?node:node?.parentElement;return Boolean(element?.closest('input,textarea,[contenteditable="true"],[role="textbox"]'))}
document.addEventListener('mouseup',event=>{if(!preferences.selectionModeEnabled||editable(event.target as Node))return;const selection=getSelection(),text=selection?.toString().trim();if(!text||!selection?.rangeCount)return;if(preferences.autoSubmitSelection){void chrome.runtime.sendMessage({type:'NEOTALK_SUBMIT_PHRASE',frase:text,source:'selection'});return}ui.setDraft(text)} ,true);
