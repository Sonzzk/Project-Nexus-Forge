using UnrealBuildTool;

public class BackroomsEditorTarget : TargetRules
{
	public BackroomsEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V5;
		ExtraModuleNames.Add("Backrooms");
	}
}
